import 'package:flutter/material.dart';

import '../app/state/app_state.dart';
import '../widgets/product_card.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.state});

  final AppState state;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      padding: const EdgeInsets.all(12),
      itemCount: widget.state.products.length,
      itemBuilder: (context, index) {
        final product = widget.state.products[index];
        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: ProductCard(
            product: product,
            onAdd: () => widget.state.addToCart(product),
            onRemove: () => widget.state.removeFromCart(product),
          ),
        );
      },
    );
  }
}
