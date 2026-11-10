class Product {
  const Product({
    required this.id,
    required this.name,
    required this.priceCents,
    this.inStock = true,
  });

  final String id;
  final String name;
  final int priceCents;
  final bool inStock;
}
