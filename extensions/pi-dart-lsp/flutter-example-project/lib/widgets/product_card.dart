import 'package:flutter/material.dart';

import '../app/models/product.dart';
import '../utils/formatters.dart';

class ProductCard extends StatelessWidget {
  const ProductCard({
    super.key,
    required this.product,
    required this.onAdd,
    required this.onRemove,
  });

  final Product product;
  final VoidCallback onAdd;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        title: Text(product.name),
        subtitle: Text(formatCents(product.priceCents)),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextButton(onPressed: onRemove, child: const Text('-')),
            TextButton(onPressed: product.inStock ? onAdd : null, child: const Text('+')),
            if (!product.inStock)
              const Padding(
                padding: EdgeInsets.only(left: 4),
                child: Text('out of stock', style: TextStyle(fontSize: 11)),
              ),
          ],
        ),
      ),
    );
  }
}
