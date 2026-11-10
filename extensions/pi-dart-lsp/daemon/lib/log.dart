import 'dart:io';

/// Per-instance daemon log: `<stateDir>/daemon-<startMs>-<pid>.log`.
///
/// - The start time in the name keeps names unique across PID namespaces (several containers on
///   one workspace volume) and sorts files by time.
/// - Every line is written synchronously (unbuffered `RandomAccessFile`), so it survives `exit()`.
/// - At most [maxLines] lines: when the file reaches [maxLines], it is rewritten with the newest
///   [keepLines] lines (temp file + rename). One rewrite per `maxLines - keepLines` new lines.
/// - Line format: `<ISO-8601 local timestamp> [daemon|lsp] <message>`.
/// - Old files are deleted by the extension at startup (7 days, see client `cleanupLogs`).
class DaemonLog {
  DaemonLog(String stateDir)
      : path = '$stateDir/daemon-${DateTime.now().millisecondsSinceEpoch}-$pid.log' {
    _raf = File(path).openSync(mode: FileMode.append);
  }

  static const maxLines = 10000;
  static const keepLines = 9000;

  final String path;
  late RandomAccessFile _raf;
  int _lines = 0;

  void daemon(String message) => _write('[daemon]', message);
  void lsp(String line) => _write('[lsp]', line);

  void _write(String tag, String message) {
    for (final line in message.split('\n')) {
      final text = '${DateTime.now().toIso8601String()} $tag $line';
      try {
        _raf.writeStringSync('$text\n');
      } catch (_) {}
      try {
        stderr.writeln(text); // visible when the daemon is started by hand
      } catch (_) {}
      _lines++;
      if (_lines >= maxLines) _trim();
    }
  }

  void _trim() {
    try {
      _raf.closeSync();
      final all = File(path).readAsLinesSync();
      final keep = all.length > keepLines ? all.sublist(all.length - keepLines) : all;
      final tmp = File('$path.tmp');
      tmp.writeAsStringSync(keep.isEmpty ? '' : '${keep.join('\n')}\n', flush: true);
      tmp.renameSync(path);
      _lines = keep.length;
    } catch (_) {
      _lines = 0;
    }
    _raf = File(path).openSync(mode: FileMode.append);
  }
}
