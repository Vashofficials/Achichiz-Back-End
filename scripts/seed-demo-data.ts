import { db } from '../src/db/client.js';
import {
  hamperItems,
  addOns,
  personalisationTemplates,
  builderTemplates,
  builderTemplateSteps,
  builderStepOptions,
  purchaseOrders,
  stockMovements,
  inventoryLevels,
} from '../src/db/schema/index.js';

async function seed() {
  console.log('Seeding API demo data...');

  // Hamper Item
  const [hamperItem] = await db.insert(hamperItems).values({
    sku: 'api-demo-hi-01',
    name: 'API Demo Hamper Item',
    costPaise: 50000,
    unit: 'pcs',
    isPerishable: false,
    status: 'active',
  }).returning({ id: hamperItems.id }).onConflictDoNothing();

  // Add-on (Gift Wrap)
  await db.insert(addOns).values({
    code: 'api-demo-gift-wrap',
    name: 'API Demo Gift Wrap',
    kind: 'packaging',
    pricePaise: 25000,
    requiresInput: false,
    status: 'active',
  }).onConflictDoNothing();

  // Personalisation
  await db.insert(personalisationTemplates).values({
    name: 'API Demo Personalisation',
    method: 'engraving',
    charLimit: 50,
    surchargePaise: 15000,
    status: 'active',
  }).onConflictDoNothing();

  // BYOH Template (4-Slot Hamper)
  const [template] = await db.insert(builderTemplates).values({
    handle: 'api-demo-4-slot',
    name: 'API Demo 4-Slot Hamper',
    basePricePaise: 100000,
    status: 'live',
  }).returning({ id: builderTemplates.id }).onConflictDoNothing();

  if (template && hamperItem) {
    const [step] = await db.insert(builderTemplateSteps).values({
      templateId: template.id,
      position: 1,
      title: 'Choose Items',
      minChoices: 4,
      maxChoices: 4,
      stepKind: 'items',
    }).returning({ id: builderTemplateSteps.id });

    await db.insert(builderStepOptions).values({
      stepId: step.id,
      hamperItemId: hamperItem.id,
      label: 'API Demo Hamper Item',
      pricePaise: 0,
      position: 1,
    });
  }

  console.log('Demo data seeded successfully!');
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
