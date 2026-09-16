import { db } from '../config/db.js';
import {
  collections,
  mediaAssets,
  customers,
  orders,
  staffUsers,
  deliveryZones,
  deliveryZonePincodes,
  warehouses,
} from '../db/schema/index.js';

async function main() {
  try {
    const allCols = await db.select({
      id: collections.id,
      handle: collections.handle,
      title: collections.title,
      kind: collections.kind,
      parentId: collections.parentId,
      status: collections.status,
      deletedAt: collections.deletedAt,
    }).from(collections);
    console.log(`--- Collections (${allCols.length}) ---`);
    console.table(allCols);

    const allMedia = await db.select({
      id: mediaAssets.id,
      storageKey: mediaAssets.storageKey,
      filename: mediaAssets.filename,
      kind: mediaAssets.kind,
      folder: mediaAssets.folder,
      deletedAt: mediaAssets.deletedAt,
    }).from(mediaAssets).limit(30);
    console.log(`--- Sample Media Assets (first 30 of 151) ---`);
    console.table(allMedia);

    const allOrders = await db.select({
      id: orders.id,
      orderNo: orders.orderNo,
      status: orders.status,
      totalPaise: orders.totalPaise,
    }).from(orders);
    console.log(`--- Orders (${allOrders.length}) ---`);
    console.table(allOrders);

    const allCustomers = await db.select({
      id: customers.id,
      mobile: customers.mobile,
      email: customers.email,
      fullName: customers.fullName,
    }).from(customers);
    console.log(`--- Customers (${allCustomers.length}) ---`);
    console.table(allCustomers);

    const allStaff = await db.select({
      id: staffUsers.id,
      email: staffUsers.email,
      fullName: staffUsers.fullName,
      status: staffUsers.status,
    }).from(staffUsers);
    console.log(`--- Staff Users (${allStaff.length}) ---`);
    console.table(allStaff);

  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

main();
