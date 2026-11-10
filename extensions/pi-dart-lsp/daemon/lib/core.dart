import 'dart:async';
import 'dart:io';

import 'gate.dart';
import 'lsp.dart';
import 'queries.dart';
import 'resolve.dart';
import 'state.dart';
import 'util.dart';

/// Shared state + helpers for the query implementations.
abstract class CoreBase {
  CoreBase(this.workspace);

  final String workspace;
  late final DaemonState state;
  late final LspClient lsp;
  late FreshnessGate gate;
  late final SymbolResolver resolver;

  /// Completer for the workspace/applyEdit sent while executing a fix
  /// command.
  Completer<Map<String, dynamic>>? commandApplyEdit;

  /// LSP request with bounded -32007 ("File is not being analyzed") retry.
  Future<dynamic> lspCall(String method, Map<String, dynamic> params,
      {Duration timeout = const Duration(seconds: 60)}) async {
    const retries = 20;
    for (var i = 0; i < retries; i++) {
      try {
        return await lsp.request(method, params, timeout: timeout);
      } on LspError catch (e) {
        if (e.code == -32007 && i < retries - 1) {
          await Future<void>.delayed(const Duration(milliseconds: 300));
          continue;
        }
        rethrow;
      }
    }
    throw StateError('unreachable');
  }

  Future<GateResult> runGate() => gate.run();

  Future<void> hookSync(String path) => gate.syncPath(path);

  String rel(String path) {
    if (path.startsWith(workspace)) {
      return path.substring(workspace.length + 1);
    }
    return path;
  }

  bool isInsideWorkspace(String path) =>
      path == workspace || path.startsWith('$workspace/');

  List<String> linesOf(String path) =>
      File(path).readAsStringSync().split('\n');

  String? lineAt(String path, int line) {
    try {
      final lines = linesOf(path);
      if (line < 0 || line >= lines.length) return null;
      return lines[line];
    } catch (_) {
      return null;
    }
  }

  /// Opens a file for analysis (priority file) if not open already.
  Future<void> openPath(String path) async {
    if (state.open.containsKey(path)) return;
    final f = File(path);
    if (!f.existsSync()) return;
    final text = f.readAsStringSync();
    state.open[path] = DocState(text);
    await lsp.notify('textDocument/didOpen', {
      'textDocument': {
        'uri': fileUri(path),
        'languageId': 'dart',
        'version': 1,
        'text': text,
      }
    });
    state.pendingChanges.add(path);
  }

  String resolveFileHint(String hint) => resolver.resolveFile(hint);

  // ------------------------------------------------------------------------
  // Settled-analysis barrier
  // ------------------------------------------------------------------------
  bool _sawTrueSinceBarrier = false;
  Completer<void>? _idle;

  void _barrierReset() {
    _sawTrueSinceBarrier = false;
    _idle = null;
  }

  /// Waits until the analysis wave caused by pending changes has finished.
  /// Returns false (and the caller must warn) when the cap is hit.
  Future<bool> awaitSettled({
    required Duration cap,
    required bool hasLiveFile,
  }) async {
    if (state.pendingChanges.isEmpty) {
      _barrierReset();
      return true;
    }
    _barrierReset();
    var settled = true;
    if (hasLiveFile) {
      // Put a hover barrier on one changed, open file: the server can only
      // answer after analyzing it, and it sent isAnalyzing:true before the
      // answer. The next isAnalyzing:false ends the wave.
      String? barrierPath;
      for (final p in state.pendingChanges) {
        if (state.open.containsKey(p)) {
          barrierPath = p;
          break;
        }
      }
      if (barrierPath != null) {
        try {
          await lspCall(
            'textDocument/hover',
            {
              'textDocument': {'uri': fileUri(barrierPath)},
              'position': {'line': 0, 'character': 0},
            },
            timeout: cap,
          );
        } on LspError {
          // File may be unresolvable; fall through to the status wait.
        } catch (_) {
          settled = false;
        }
      }
    }
    if (_sawTrueSinceBarrier) {
      final idle = _idle;
      if (idle != null) {
        try {
          await idle.future.timeout(cap,
              onTimeout: () => throw TimeoutException('analysis not settled'));
        } on TimeoutException {
          settled = false;
        }
      }
    }
    state.pendingChanges.clear();
    _barrierReset();
    return settled;
  }
}

class Core extends CoreBase with Queries {
  Core(super.workspace);

  Process? _proc;
  int? _exitCode;

  /// Notified when the LSP child process exits (crash or after [stop]).
  void Function(int exitCode)? onLspExit;

  /// Every stderr line of the LSP child.
  void Function(String line)? onLspStderr;

  static String? _dartPath;
  static String dartPath() {
    if (_dartPath != null) return _dartPath!;
    final flutter = Platform.environment['FLUTTER_PATH'];
    if (flutter != null && flutter.isNotEmpty) {
      final candidate = '$flutter/bin/dart';
      if (File(candidate).existsSync()) {
        _dartPath = candidate;
        return candidate;
      }
    }
    _dartPath = 'dart';
    return 'dart';
  }

  Future<void> start() async {
    state = DaemonState(workspace);
    // Baseline: index the disk BEFORE starting the server, so any later edit
    // gets a newer stamp.
    state.index.addAll(scanDartFiles(workspace));
    gate = FreshnessGate(state);
    resolver = SymbolResolver(state);
    resolver.lsp = (m, p) => lspCall(m, p);

    final cacheDir = '$workspace/.pi/lsp/cache';
    Directory(cacheDir).createSync(recursive: true);
    final env = Map<String, String>.from(Platform.environment);
    _proc = await Process.start(
      dartPath(),
      [
        'language-server',
        '--cache=$cacheDir',
        '--client-id=pi-dart-lsp',
      ],
      workingDirectory: workspace,
      environment: env,
    );
    lsp = LspClient(
      _proc!,
      onDiagnostics: (uri, diags) {
        state.diagnostics[uri] = diags;
      },
      onAnalyzerStatus: (analyzing) {
        if (analyzing && !analysisStarted.isCompleted) analysisStarted.complete();
        final was = state.analyzing;
        state.analyzing = analyzing;
        if (analyzing && !was) {
          _sawTrueSinceBarrier = true;
          _idle = Completer<void>();
        } else if (!analyzing && was) {
          _idle?.complete();
        }
      },
      onApplyEdit: (params) {
        final c = commandApplyEdit;
        if (c != null && !c.isCompleted) {
          c.complete((params['edit'] as Map<String, dynamic>? ?? const {}));
        }
      },
      onStderrLine: (line) => onLspStderr?.call(line),
      onExit: (code) {
        _exitCode = code;
        onLspExit?.call(code);
      },
    );
    gate.lsp = lsp;

    await lsp.request('initialize', {
      'processId': pid,
      'rootUri': fileUri(workspace),
      'capabilities': {
        'workspace': {
          'configuration': true,
          // The server reads the legacy key to gate workspace/applyEdit.
          'applyEdit': true,
          'workspaceEdit': {'apply': true, 'documentChanges': true},
        },
        'textDocument': {
          'documentSymbol': {'hierarchicalDocumentSymbolSupport': true},
          'codeAction': {
            'kind': {
              'valueSet': [
                'quickfix',
                'refactor',
                'refactor.extract',
                'refactor.inline',
                'refactor.rewrite',
                'source'
              ]
            },
            'literalSupport': true,
            'dataSupport': true,
            'resolveSupport': {'properties': ['edit']},
          },
        },
      },
    });
    await lsp.notify('initialized', {});
    // Right after `initialized` the server has no analysis roots yet and answers e.g.
    // `workspace/symbol` with an empty list. Once it reports analysis, it holds such requests until
    // results are ready. Measured: ~0.35 s with a warm cache, ~4 s with an empty one.
    await analysisStarted.future.timeout(analysisStartCap, onTimeout: () {});
  }

  /// Completed by the server's first `$/analyzerStatus {isAnalyzing: true}`.
  final Completer<void> analysisStarted = Completer<void>();
  static const analysisStartCap = Duration(seconds: 30);

  /// Stops the LSP child and waits until it is gone (reaped by this process), so that no orphan /
  /// zombie survives the daemon and no second server ever works on the shared cache.
  /// Returns the child's exit code, or null if it was never started.
  Future<int?> stop() async {
    final proc = _proc;
    if (proc == null) return null;
    if (_exitCode != null) return _exitCode;
    // `lsp` is late: if start() failed before assigning it, the catch swallows the error.
    try {
      await lsp.request('shutdown', {}, timeout: const Duration(seconds: 2));
    } catch (_) {}
    try {
      await lsp.notify('exit', {});
    } catch (_) {}
    try {
      return await proc.exitCode.timeout(const Duration(seconds: 5));
    } on TimeoutException {
      proc.kill(ProcessSignal.sigkill);
      return proc.exitCode;
    }
  }
}
