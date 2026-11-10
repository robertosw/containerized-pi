/// Lightweight string validation used by forms.
class Validator {
  const Validator._();

  static String? requiredText(String value, {String field = 'field'}) {
    if (value.trim().isEmpty) return '$field is required';
    return null;
  }

  static String? email(String value) {
    if (value.isEmpty) return null;
    final at = value.indexOf('@');
    if (at < 1 || value.indexOf('.', at) == -1) return 'invalid email';
    return null;
  }

  static String? positiveInt(String value) {
    final n = int.tryParse(value);
    if (n == null || n <= 0) return 'must be a positive number';
    return null;
  }
}
