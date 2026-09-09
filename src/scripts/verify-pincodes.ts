import { checkServiceability } from '../modules/catalogue/catalogue.service.js';

async function verify() {
  const testPins = ['226024', '226010', '226001', '226016', '226301', '226101', '110001'];
  console.log('Testing live serviceability for PIN codes:');

  for (const pin of testPins) {
    const res = await checkServiceability(pin);
    console.log(`PIN ${pin} (${res.city || 'Outside'}): serviceable=${res.serviceable}, sameDay=${res.sameDayEligible}, cod=${res.codEligible}`);
  }

  process.exit(0);
}

verify().catch((e) => {
  console.error(e);
  process.exit(1);
});
