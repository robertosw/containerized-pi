import '../models/product.dart';

class CatalogService {
  final List<Product> _products = const [
    Product(id: 'p1', name: 'Espresso Beans', priceCents: 1499),
    Product(id: 'p2', name: 'Ceramic Mug', priceCents: 2499),
    Product(id: 'p3', name: 'Pour-Over Kettle', priceCents: 5999),
    Product(id: 'p4', name: 'Gooseneck Strainer', priceCents: 399, inStock: false),
    Product(id: 'p5', name: 'Milk Frother', priceCents: 1999),
  ];

  List<Product> get products => List.unmodifiable(_products);

  void load() {
    // Synchronous in this example; a real implementation would be async.
  }

  Product? find(String id) {
    for (final product in _products) {
      if (product.id == id) return product;
    }
    return null;
  }
}
