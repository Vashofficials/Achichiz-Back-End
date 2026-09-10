async function test() {
  const handles = [
    'all-bamboo-product-workspace-collection',
    'eco-stationery',
    'earth-aroma-collection',
    'jhumkas',
    'temple-jewellery',
    'drinkware',
    'earrings',
    'danglers',
    'necklaces',
  ];

  console.log('Testing Storefront API endpoints on http://localhost:4000/v1/products ...\n');

  for (const h of handles) {
    try {
      const res = await fetch(`http://localhost:4000/v1/products?collection=${encodeURIComponent(h)}`);
      const data = await res.json();
      const items = Array.isArray(data.result) ? data.result : data.result?.items || [];
      const meta = data.meta || data.result?.meta;
      const bounds = data.priceBounds || data.meta?.priceBounds || data.result?.priceBounds;

      console.log(`📌 Collection [${h}]:`);
      console.log(`   HTTP Status: ${res.status}`);
      console.log(`   Items Returned: ${items.length}`);
      console.log(`   Meta Total: ${meta?.total ?? items.length}`);
      console.log(`   Price Bounds:`, bounds ? `₹${bounds.minPaise / 100} - ₹${bounds.maxPaise / 100}` : 'None');
      if (items.length > 0) {
        console.log(`   Sample Products: ${items.slice(0, 3).map((p: any) => `"${p.title}" (₹${(p.pricePaise || p.price_paise || 0) / 100})`).join(', ')}`);
        console.log(`   First product payload:`, JSON.stringify(items[0], null, 2));
      }
      console.log('');
    } catch (err: any) {
      console.error(`❌ Error fetching ${h}:`, err.message);
    }
  }
}

test();
