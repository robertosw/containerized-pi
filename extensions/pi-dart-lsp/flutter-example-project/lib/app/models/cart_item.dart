import 'product.dart';

class CartItem {
  const CartItem({required this.product, required this.quantity});

  final Product product;
  final int quantity;

  int get subtotalCents => product.priceCents * quantity;

  CartItem copiedWithQuantity(int newQuantity) =>
      CartItem(product: product, quantity: newQuantity);
}
