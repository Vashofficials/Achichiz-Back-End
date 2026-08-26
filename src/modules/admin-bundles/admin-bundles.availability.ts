/**
 * Bundle availability — pure arithmetic, no database, no HTTP.
 *
 * ## §91: a bundle has no stock of its own
 *
 * A bundle is not a stockable. There is no `inventory_levels` row for a bundle
 * and there must never be one, because a bundle is an *assertion about other
 * rows*: "one bottle, one pen, one diary". The moment you store a number beside
 * the bundle it becomes a second opinion about stock that nothing keeps in step
 * with the first, and the two disagree the first time somebody buys a pen on its
 * own. That divergence is exactly how the Build Your Own Hamper flow currently
 * oversells.
 *
 * So availability is COMPUTED, every time, from the components:
 *
 * ```
 *   fulfillable(component) = floor(component.available / component.required)
 *   fulfillable(bundle)    = MIN over components
 * ```
 *
 * A gift set of 1 bottle + 1 pen + 1 diary against 100 / 75 / 100 available is
 * 75 bundles, not 275 and not 100. The scarcest component is the answer, which
 * is why the limiting components are named in the result rather than left for
 * the caller to re-derive.
 *
 * Two boundaries worth stating, because both are easy to get subtly wrong:
 *
 *  1. **An empty bundle is 0, not infinity.** `Math.min()` over no arguments is
 *     `Infinity`, and a bundle with no items would otherwise report itself as
 *     infinitely fulfillable — the single most dangerous number this file could
 *     return. It is refused explicitly.
 *  2. **Zero available on ONE component makes the whole bundle unfulfillable**,
 *     however healthy the rest are. `floor(0 / n)` is 0 and 0 wins the MIN.
 *
 * Nothing here rounds up. Stock is counted in whole units, so `floor` is the
 * only honest direction: 7 pens make 3 two-pen bundles, never 3.5 and never 4.
 */

/** One component of a bundle, with the stock position already resolved for it. */
export type BundleComponentStock = {
  variantId: string;
  /** Units of this component consumed by ONE bundle. `bundle_items.quantity`, always ≥ 1. */
  requiredQty: number;
  /** Sellable units — `on_hand − reserved`, the GENERATED column. Never on-hand alone. */
  availableQty: number;
};

export type BundleComponentAvailability = {
  variantId: string;
  /** Per one bundle. */
  required: number;
  /** Sellable units of the component. */
  available: number;
  /** Units still needed to build the requested quantity of bundles. 0 when it is covered. */
  shortage: number;
  /** How many whole bundles this component alone could cover. */
  fulfillableQty: number;
  /** True when this component is one of the ones setting the MIN. */
  isLimiting: boolean;
};

export type BundleAvailability = {
  /** The quantity the question was asked about. Defaults to 1. */
  requestedQty: number;
  /** `MIN(floor(available / required))` across every component. */
  fulfillableQty: number;
  /** `fulfillableQty >= requestedQty`. */
  canFulfil: boolean;
  components: BundleComponentAvailability[];
  /** The components whose stock is the constraint — what to reorder. */
  limitingVariantIds: string[];
};

/**
 * How many whole bundles one component can cover.
 *
 * A non-positive `requiredQty` cannot exist — `bundle_items` carries
 * `CHECK (quantity > 0)` — but a line that consumed nothing would divide by zero
 * here, so it is treated as unconstraining (`Infinity`) rather than allowed to
 * produce a `NaN` that silently poisons the MIN.
 */
export function componentFulfillableQty(component: BundleComponentStock): number {
  if (component.requiredQty <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(Math.max(0, component.availableQty) / component.requiredQty);
}

/**
 * THE bundle availability computation. One function, one place.
 *
 * `requestedQty` only affects `shortage` and `canFulfil`; `fulfillableQty` is
 * the unconditional answer to "how many could we ship right now", which is what
 * the console shows beside the bundle.
 */
export function bundleAvailability(
  components: readonly BundleComponentStock[],
  requestedQty = 1,
): BundleAvailability {
  const wanted = Math.max(1, Math.trunc(requestedQty));

  if (components.length === 0) {
    // See the header: MIN over nothing is Infinity, and "infinitely available"
    // is the worst possible answer for a bundle nobody has put items in.
    return {
      requestedQty: wanted,
      fulfillableQty: 0,
      canFulfil: false,
      components: [],
      limitingVariantIds: [],
    };
  }

  const perComponent = components.map((c) => ({
    component: c,
    fulfillable: componentFulfillableQty(c),
  }));

  const finite = perComponent.filter((p) => Number.isFinite(p.fulfillable));
  const fulfillableQty = finite.length === 0 ? 0 : Math.min(...finite.map((p) => p.fulfillable));

  const rows: BundleComponentAvailability[] = perComponent.map(({ component, fulfillable }) => ({
    variantId: component.variantId,
    required: component.requiredQty,
    available: component.availableQty,
    shortage: Math.max(0, component.requiredQty * wanted - component.availableQty),
    fulfillableQty: Number.isFinite(fulfillable) ? fulfillable : 0,
    isLimiting: Number.isFinite(fulfillable) && fulfillable === fulfillableQty,
  }));

  return {
    requestedQty: wanted,
    fulfillableQty,
    canFulfil: fulfillableQty >= wanted,
    components: rows,
    limitingVariantIds: rows.filter((r) => r.isLimiting).map((r) => r.variantId),
  };
}

/**
 * `SUM(component list price × quantity) − bundlePricePaise`.
 *
 * Derived, never stored — the `bundles` table deliberately has no `savings`
 * column, because a component's price changes without the bundle being touched
 * and a stored saving would then be advertising a discount that is not real.
 * Integer paise throughout; a negative result means the bundle costs MORE than
 * its parts, which is a pricing mistake worth surfacing rather than clamping.
 */
export function bundleSavingsPaise(
  components: readonly { quantity: number; unitPricePaise: number }[],
  bundlePricePaise: number,
): { componentTotalPaise: number; savingsPaise: number; savingsBp: number } {
  const componentTotalPaise = components.reduce((sum, c) => sum + c.quantity * c.unitPricePaise, 0);
  const savingsPaise = componentTotalPaise - bundlePricePaise;
  const savingsBp =
    componentTotalPaise > 0 ? Math.round((savingsPaise * 10_000) / componentTotalPaise) : 0;
  return { componentTotalPaise, savingsPaise, savingsBp };
}
