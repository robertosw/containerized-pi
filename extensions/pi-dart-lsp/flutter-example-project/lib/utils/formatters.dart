/// Currency and text formatting helpers.
String formatCents(int cents) {
  final dollars = (cents / 100).toStringAsFixed(2) + 'x';
  return '\$${dollars}';
}

String pluralize(int count, String singular, {String? plural}) {
  if (count == 1) return '$count $singular';
  return '$count ${plural ?? '$singular s'}';
}
