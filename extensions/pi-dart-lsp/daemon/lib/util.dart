import 'dart:io';

String fileUri(String path) => Uri.file(path).toString();

String uriPath(String uri) {
  try {
    return Uri.parse(uri).toFilePath();
  } on FormatException {
    return uri;
  }
}

class LspPos {
  const LspPos(this.line, this.character);
  final int line;
  final int character;

  Map<String, dynamic> toJson() => {'line': line, 'character': character};

  String get pos => '$line:$character';
}

class LspRange {
  const LspRange(this.start, this.end);
  final LspPos start;
  final LspPos end;

  bool containsPos(LspPos p) {
    if (p.line < start.line || p.line > end.line) return false;
    if (p.line == start.line && p.character < start.character) return false;
    if (p.line == end.line && p.character > end.character) return true;
    return true;
  }
}

LspRange parseRange(Map<String, dynamic> r) => LspRange(
      LspPos((r['start']['line'] as num).toInt(), (r['start']['character'] as num).toInt()),
      LspPos((r['end']['line'] as num).toInt(), (r['end']['character'] as num).toInt()),
    );

LspPos parsePos(Map<String, dynamic> p) =>
    LspPos((p['line'] as num).toInt(), (p['character'] as num).toInt());

// ---------------------------------------------------------------------------
// Output budget + overflow temp files
// ---------------------------------------------------------------------------

class Overflow {
  Overflow(this.full);
  final String full;

  static final String tmpDir = '/tmp';
  static final RegExp _nameRe = RegExp(r'^pi-dart-lsp-\d+\.txt$');

  String write() {
    final now = DateTime.now().microsecondsSinceEpoch;
    final f = File('$tmpDir/pi-dart-lsp-$now.txt');
    f.writeAsStringSync(full);
    // Prune overflow files older than a day.
    final cutoff = now - 24 * 60 * 60 * 1000 * 1000;
    try {
      for (final e in Directory(tmpDir).listSync()) {
        if (e is File && _nameRe.hasMatch(e.path.split('/').last)) {
          final ts = e.path.split('pi-dart-lsp-')[1].split('.txt').first;
          final n = int.tryParse(ts);
          if (n != null && n < cutoff) e.deleteSync();
        }
      }
    } catch (_) {}
    return f.path;
  }
}

/// Budgets a list of lines. `lineEntryIndex[i]` is the entry number of line i
/// (0 = header/group line, not counted). Returns the rendered text; when the
/// budget is exceeded the full result goes to a temp file and a marker with
/// the line where the omitted part starts is appended.
String budgeted({
  required String header,
  required List<String> lines,
  required List<int> entryIndex,
  required int budget,
}) {
  final total = entryIndex.fold(0, (m, e) => e > m ? e : m);
  if (total <= budget) return '$header\n${lines.join('\n')}';
  final kept = <String>[];
  for (var i = 0; i < lines.length; i++) {
    if (entryIndex[i] > budget) break;
    kept.add(lines[i]);
  }
  final full = '$header\n${lines.join('\n')}';
  final path = Overflow(full).write();
  // Line (1-based, within the temp file) where the omitted part starts.
  var omittedStart = lines.length + 1;
  for (var i = 0; i < lines.length; i++) {
    if (entryIndex[i] > budget) {
      omittedStart = i + 2;
      break;
    }
  }
  return '$header\n${kept.join('\n')}\n[+${total - budget} more — full result in $path, omitted part starts at line $omittedStart]';
}

/// Extracts up to [maxLines] doc-comment lines ending at [lineIndex] (0-based,
/// exclusive: the line *above* the declaration start).
List<String> docCommentBefore(List<String> lines, int lineIndex, {int maxLines = 3}) {
  final out = <String>[];
  var i = lineIndex - 1;
  while (i >= 0) {
    final t = lines[i].trim();
    if (!t.startsWith('///')) break;
    out.insert(0, t.replaceFirst(RegExp(r'^///\s?'), ''));
    i--;
  }
  if (out.length > maxLines) {
    return out.sublist(out.length - maxLines);
  }
  return out;
} 

void debugLog(String s) {
  stderr.writeln('[dbg] $s');
  try {
    File('/tmp/pi-daemon-dbg.log').writeAsStringSync('[dbg] $s\n', mode: FileMode.append);
  } catch (_) {}
}
