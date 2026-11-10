import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:pi_dart_lsp/core.dart';
import 'package:pi_dart_lsp/log.dart';

/// Exit code of a daemon that did not get the workspace lock (another daemon serves the workspace).
const exitLockHeld = 75;

Future<void> main(List<String> args) async {
  if (args.length < 1) {
    stderr.writeln('usage: daemon <workspace>');
    exit(64);
  }
  final workspace = File(args[0]).absolute.path;
  if (!Directory(workspace).existsSync()) {
    stderr.writeln('workspace does not exist: $workspace');
    exit(64);
  }
  final stateDir = '$workspace/.pi/lsp';
  Directory('$stateDir/bin').createSync(recursive: true);
  final log = DaemonLog(stateDir);
  final portFile = File('$stateDir/port');
  final pidFile = File('$stateDir/pid');

  // Binary freshness stamp: (mtime, size) of this executable.
  final binStat = File(Platform.resolvedExecutable).statSync();
  final binMtime = binStat.modified.millisecondsSinceEpoch;
  final binSize = binStat.size;
  final idleTimeout = _idleTimeout(log);
  log.daemon('start pid=$pid workspace=$workspace binary=(mtime=$binMtime size=$binSize) '
      'idleTimeout=${idleTimeout.inSeconds}s');

  // One daemon per workspace. Kernel (fcntl) lock, released on process death: no stale locks, works
  // across PID namespaces. Keep `lock` open for the whole process lifetime and never open this file a
  // second time in this process: closing ANY handle of it drops the lock.
  final lock = File('$stateDir/daemon.lock').openSync(mode: FileMode.append);
  if (!await _acquireLock(lock)) {
    log.daemon('lock held by another daemon for 10s; exiting without starting the language server');
    exit(exitLockHeld);
  }
  log.daemon('lock acquired');

  final core = Core(workspace)..onLspStderr = log.lsp;
  try {
    await core.start();
  } catch (e) {
    log.daemon('language server start failed: $e');
    final code = await core.stop();
    log.daemon('language server stopped (exit code ${code ?? 'n/a'}); exiting');
    exit(1);
  }
  log.daemon(core.analysisStarted.isCompleted
      ? 'language server analyzing'
      : 'language server reported no analysis within ${Core.analysisStartCap.inSeconds}s; serving anyway');

  // Instance token: identifies THIS daemon in the port file and in `ping`. Lets a client tell a
  // stale port file (token differs) from the same state dir mounted at another path (token matches,
  // workspace differs).
  final rnd = Random.secure();
  final token = List.generate(16, (_) => rnd.nextInt(256).toRadixString(16).padLeft(2, '0')).join();

  final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final portLine = '${server.port} $token';
  final portTmp = File('$stateDir/port.tmp-$pid');
  portTmp.writeAsStringSync(portLine, flush: true);
  portTmp.renameSync(portFile.path); // atomic: a reader never sees a partial line
  pidFile.writeAsStringSync('$pid');
  log.daemon('listening port=${server.port}');

  var connections = 0;
  var shuttingDown = false;
  final sockets = <Socket>[];
  Timer? idleTimer;

  void removeOwnFiles() {
    try {
      if (portFile.readAsStringSync().trim() == portLine) {
        portFile.deleteSync();
      }
    } catch (_) {}
    try {
      if (pidFile.readAsStringSync().trim() == '$pid') {
        pidFile.deleteSync();
      }
    } catch (_) {}
  }

  Future<void> shutdown({required String reason}) async {
    if (shuttingDown) return;
    shuttingDown = true;
    idleTimer?.cancel();
    log.daemon('shutting down: $reason');
    removeOwnFiles();
    try {
      await server.close();
    } catch (_) {}
    // Copy: destroy() runs onDone synchronously, which removes the socket from `sockets`.
    for (final s in List.of(sockets)) {
      try {
        s.destroy();
      } catch (_) {}
    }
    final code = await core.stop();
    log.daemon('language server stopped (exit code ${code ?? 'n/a'}); exiting');
    exit(0); // releases the lock
  }

  void armIdleTimer() {
    idleTimer?.cancel();
    idleTimer = Timer(
      idleTimeout,
      () => shutdown(reason: 'idle: no connection for ${idleTimeout.inSeconds}s'),
    );
  }

  core.onLspExit = (code) => shutdown(reason: 'language server exited (exit code $code)');
  armIdleTimer(); // covers "never connected"

  // Serial request queue: one in-flight request at a time. `ping` bypasses it.
  var chain = Future<void>.value();

  Future<bool> retired() async {
    try {
      final st = File(Platform.resolvedExecutable).statSync();
      if (st.modified.millisecondsSinceEpoch != binMtime ||
          st.size != binSize) {
        return true;
      }
    } catch (_) {}
    return false;
  }

  Future<void> handle(Socket socket, Map<String, dynamic> req) async {
    final id = req['id'];
    final method = req['method'] as String?;
    final params = (req['params'] as Map<String, dynamic>?) ?? {};
    void respond(Object? result, {String? error}) {
      final msg = <String, dynamic>{'id': id};
      if (error != null) {
        msg['error'] = error;
      } else {
        msg['result'] = result;
      }
      try {
        socket.add(utf8.encode('${jsonEncode(msg)}\n'));
      } catch (_) {}
    }

    if (method == null) return;
    if (await retired()) {
      shutdown(reason: 'binary replaced (newer build)');
      return;
    }
    try {
      switch (method) {
        case 'ping':
          respond({'workspace': workspace, 'pid': pid, 'token': token});
          return;
        case 'sync':
          await core.hookSync(params['path'] as String);
          respond({'ok': true});
          return;
        case 'stop':
          respond({'ok': true});
          shutdown(reason: 'stop requested');
          return;
        case 'references':
        case 'definition':
        case 'outline':
        case 'hierarchy':
        case 'diagnose':
        case 'fix':
          await core.runGate();
          switch (method) {
            case 'references':
              respond(await core.references(params));
            case 'definition':
              respond(await core.definition(params));
            case 'outline':
              respond(await core.outline(params));
            case 'hierarchy':
              respond(await core.hierarchy(params));
            case 'diagnose':
              respond(await core.diagnose(params));
            case 'fix':
              respond(await core.fix(params));
          }
          return;
        default:
          respond(null, error: 'unknown method: $method');
      }
    } catch (e) {
      respond(null, error: '$e');
    }
  }

  server.listen((socket) {
    connections++;
    idleTimer?.cancel();
    log.daemon('connection opened ($connections open)');
    sockets.add(socket);
    socket.setOption(SocketOption.tcpNoDelay, true);
    var buf = '';
    socket.listen(
      (data) {
        buf += utf8.decode(data, allowMalformed: true);
        var idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          final line = buf.substring(0, idx).trim();
          buf = buf.substring(idx + 1);
          if (line.isEmpty) continue;
          Map<String, dynamic> req;
          try {
            req = jsonDecode(line) as Map<String, dynamic>;
          } catch (_) {
            continue;
          }
          if (req['method'] == 'ping') {
            // Liveness must not wait behind a long query: clients verify a daemon with a short
            // ping timeout and would otherwise take a busy daemon for a dead one.
            handle(socket, req);
          } else {
            chain = chain.then((_) => handle(socket, req));
          }
        }
      },
      onError: (_) {},
      onDone: () {
        sockets.remove(socket);
        connections--;
        log.daemon('connection closed ($connections open)');
        if (connections <= 0 && !shuttingDown) armIdleTimer();
      },
    );
  });
}

/// Non-blocking exclusive lock, retried every 200 ms for up to 10 s. The window covers an old daemon
/// that still holds the lock while it stops its language server (≤ ~7 s).
Future<bool> _acquireLock(RandomAccessFile lock) async {
  final deadline = DateTime.now().add(const Duration(seconds: 10));
  while (true) {
    try {
      lock.lockSync(FileLock.exclusive); // non-blocking; throws when held elsewhere
      return true;
    } on FileSystemException {
      if (DateTime.now().isAfter(deadline)) return false;
      await Future<void>.delayed(const Duration(milliseconds: 200));
    }
  }
}

/// `PI_DART_LSP_IDLE_TIMEOUT_S`: positive integer seconds; default 300.
Duration _idleTimeout(DaemonLog log) {
  const fallback = Duration(seconds: 300);
  final raw = Platform.environment['PI_DART_LSP_IDLE_TIMEOUT_S'];
  if (raw == null || raw.isEmpty) return fallback;
  final seconds = int.tryParse(raw);
  if (seconds == null || seconds <= 0) {
    log.daemon('ignoring invalid PI_DART_LSP_IDLE_TIMEOUT_S="$raw"; using ${fallback.inSeconds}s');
    return fallback;
  }
  return Duration(seconds: seconds);
}
