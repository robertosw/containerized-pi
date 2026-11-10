import 'dart:io';

import 'lsp.dart';
import 'state.dart';
import 'util.dart';

const Set<String> _skipDirs = {
  'build',
  'node_modules',
  'android',
  'ios',
  'linux',
  'macos',
  'web',
  'windows',
};

class GateResult {
  GateResult({required this.newFiles, required this.changed, required this.deleted});
  final List<String> newFiles;
  final List<String> changed;
  final List<String> deleted;

  bool get empty => newFiles.isEmpty && changed.isEmpty && deleted.isEmpty;
  bool get hasLiveChanges => newFiles.isNotEmpty || changed.isNotEmpty;
}

/// Walks the workspace, stats every .dart file, and syncs differences to the
/// LSP server. Returns the differences that were applied.
class FreshnessGate {
  FreshnessGate(this.state);
  final DaemonState state;
  late LspClient lsp;

  Map<String, FileStat> scan() => scanDartFiles(state.workspace);

  Future<GateResult> run() async {
    final now = DateTime.now().millisecondsSinceEpoch;
    final onDisk = scan();
    final result = GateResult(newFiles: [], changed: [], deleted: []);

    final live = <String>{};
    for (final entry in onDisk.entries) {
      live.add(entry.key);
      final prev = state.index[entry.key];
      final same = prev != null && prev.sameAs(entry.value);

      // Unconfirmed re-read: same stamp, but content may have been forged
      // (identical size + mtime) since our last read within the 1 s window.
      if (same && state.unconfirmed.containsKey(entry.key)) {
        final text = File(entry.key).readAsStringSync();
        if (state.unconfirmed[entry.key] != text) {
          result.changed.add(entry.key);
          await _syncChanged(entry.key, text, entry.value);
          _markUnconfirmed(entry.key, text, now);
        } else {
          _confirm(entry.key, entry.value, now);
        }
        continue;
      }
      _confirm(entry.key, entry.value, now);
      if (same) continue;

      final text = File(entry.key).readAsStringSync();
      final wasOpen = state.open.containsKey(entry.key);
      if (wasOpen) {
        result.changed.add(entry.key);
      } else {
        result.newFiles.add(entry.key);
      }
      await _syncChanged(entry.key, text, entry.value);
      _markUnconfirmed(entry.key, text, now);
    }

    for (final path in state.index.keys.toList()) {
      if (!onDisk.containsKey(path)) {
        result.deleted.add(path);
        await _syncDeleted(path);
        state.index.remove(path);
      }
    }
    for (final path in state.unconfirmed.keys.toList()) {
      if (!onDisk.containsKey(path)) state.unconfirmed.remove(path);
    }
    return result;
  }

  void _confirm(String path, FileStat st, int nowMs) {
    if (nowMs - st.mtimeMs >= 1000) state.unconfirmed.remove(path);
  }

  void _markUnconfirmed(String path, String text, int nowMs) {
    final st = state.index[path];
    if (st != null && nowMs - st.mtimeMs < 1000) {
      state.unconfirmed[path] = text;
    } else {
      state.unconfirmed.remove(path);
    }
  }

  Future<void> _syncChanged(String path, String text, FileStat st) async {
    final uri = fileUri(path);
    final open = state.open[path];
    if (open == null) {
      final doc = DocState(text);
      state.open[path] = doc;
      await lsp.notify('textDocument/didOpen', {
        'textDocument': {
          'uri': uri,
          'languageId': 'dart',
          'version': 1,
          'text': text,
        }
      });
    } else {
      open.version++;
      open.text = text;
      await lsp.notify('textDocument/didChange', {
        'textDocument': {'uri': uri, 'version': open.version},
        'contentChanges': [
          {'text': text}
        ]
      });
    }
    state.index[path] = st;
    state.pendingChanges.add(path);
  }

  Future<void> _syncDeleted(String path) async {
    final uri = fileUri(path);
    if (state.open.containsKey(path)) {
      await lsp.notify('textDocument/didClose', {'textDocument': {'uri': uri}});
      state.open.remove(path);
    } else {
      // Never opened: open with empty text then close so the server drops
      // any cached view of the path.
      await lsp.notify('textDocument/didOpen', {
        'textDocument': {
          'uri': uri,
          'languageId': 'dart',
          'version': 1,
          'text': ''
        }
      });
      await lsp.notify('textDocument/didClose', {'textDocument': {'uri': uri}});
    }
    state.diagnostics.remove(uri);
    state.pendingChanges.add(path);
  }

  /// Hook path: a file was just written by the agent. Reads it now so the
  /// analysis wave starts before the next query arrives.
  Future<void> syncPath(String path) async {
    final f = File(path);
    if (!f.existsSync()) {
      await _syncDeleted(path);
      return;
    }
    final st = f.statSync();
    final stObj = FileStat(st.modified.millisecondsSinceEpoch, st.size);
    final text = f.readAsStringSync();
    await _syncChanged(path, text, stObj);
    _markUnconfirmed(path, text, DateTime.now().millisecondsSinceEpoch);
  }
}

Map<String, FileStat> scanDartFiles(String workspace) {
  final result = <String, FileStat>{};
  _walk(Directory(workspace), result);
  return result;
}

void _walk(Directory dir, Map<String, FileStat> out) {
  List<FileSystemEntity> entities;
  try {
    entities = dir.listSync(followLinks: false);
  } catch (_) {
    return;
  }
  for (final e in entities) {
    final name = e.path.split('/').last;
    if (name.startsWith('.') || _skipDirs.contains(name)) continue;
    if (e is Directory) {
      _walk(e, out);
    } else if (e is File && name.endsWith('.dart')) {
      final st = e.statSync();
      out[e.path] = FileStat(st.modified.millisecondsSinceEpoch, st.size);
    }
  }
}
