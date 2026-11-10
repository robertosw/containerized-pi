class DocState {
  DocState(this.text);
  String text = '';
  int version = 1;
}

class FileStat {
  const FileStat(this.mtimeMs, this.size);
  final int mtimeMs;
  final int size;

  bool sameAs(FileStat other) =>
      mtimeMs == other.mtimeMs && size == other.size;
}

class DaemonState {
  DaemonState(this.workspace);
  final String workspace;

  /// path -> stat, the baseline the LSP server is believed to reflect.
  final Map<String, FileStat> index = {};

  /// path -> open document.
  final Map<String, DocState> open = {};

  /// uri -> diagnostics from publishDiagnostics.
  final Map<String, List<Map<String, dynamic>>> diagnostics = {};

  /// paths synced (didOpen/didChange/didClose sent) since the last settled
  /// wait. A barrier is owed whenever this is non-empty.
  final Set<String> pendingChanges = {};

  /// Unconfirmed set: path -> last content the daemon read from disk. Files
  /// read from disk less than 1 s after their mtime live here; the gate
  /// re-reads and content-compares them on the next pass.
  final Map<String, String> unconfirmed = {};

  bool analyzing = false;
}
