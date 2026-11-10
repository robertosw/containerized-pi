import 'package:flutter/material.dart';

import 'state/app_state.dart';
import '../widgets/cart_screen.dart';
import '../widgets/home_screen.dart';
import '../widgets/order_history_screen.dart';

class ShopApp extends StatefulWidget {
  const ShopApp({super.key});

  @override
  State<ShopApp> createState() => _ShopAppState();
}

class _ShopAppState extends State<ShopApp> {
  final AppState _state = AppState();

  int _tab = 0;

  @override
  void initState() {
    super.initState();
    _state.bootstrap();
  }

  @override
  Widget build(BuildContext context) {
    final screens = <Widget>[
      HomeScreen(state: _state),
      CartScreen(state: _state),
      OrderHistoryScreen(state: _state),
    ];
    return MaterialApp(
      title: 'Shop',
      home: Scaffold(
        appBar: AppBar(title: const Text('Shop')),
        body: screens[_tab],
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: (index) => setState(() => _tab = index),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.home), label: 'Home'),
            NavigationDestination(icon: Icon(Icons.shopping_cart), label: 'Cart'),
            NavigationDestination(icon: Icon(Icons.receipt_long), label: 'Orders'),
          ],
        ),
      ),
    );
  }
}
