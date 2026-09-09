/**
 * Modular translation evaluation.
 *
 * Turns the billing units measured during a translation (characters, OCR pages,
 * images, elapsed time) into a structured cost + performance report.
 *
 * This module is intentionally pure and side-effect free, so it can run on the
 * server (where the billing units are known) and its types/formatters can be
 * reused by client components. Evaluation is OPT-IN — callers decide whether to
 * build a report, so it never adds overhead to a normal translation and is not
 * a fixed part of the translation pipeline.
 */

export type TranslationMode = "text" | "layout";

// Azure retail pay-as-you-go unit prices (southeastasia, USD), captured
// 2026-06-22 from the Azure Retail Prices API. See docs/EVALUATION.md. Override
// at deploy time with EVALUATION_PRICE_* env vars if your region/tier differs.
export const DEFAULT_PRICES = {
  region: "southeastasia",
  currency: "USD",
  // Document Intelligence — Read (S0): per 1,000 pages.
  docIntelReadPer1kPages: 1.5,
  // Translator — Text translation (S1): per 1,000,000 characters.
  textTranslatePerMChars: 10,
  // Translator — Document Translation (S1): per 1,000,000 characters.
  documentTranslatePerMChars: 15,
  // Translator — Image translation (S1): per 1,000 images.
  imageTranslatePer1kImages: 8,
} as const;

export type Prices = typeof DEFAULT_PRICES;

export interface CostItem {
  /** Human-readable service + meter, e.g. "Translator — Text translation". */
  label: string;
  /** How many billable units were consumed. */
  units: number;
  /** Natural unit for `units`: "pages" | "characters" | "images". */
  unit: "pages" | "characters" | "images";
  /** Price per the unit's natural batch (per 1K pages/images, per 1M chars). */
  unitPriceUSD: number;
  /** Size of the price batch (1000 for pages/images, 1_000_000 for chars). */
  per: number;
  /** Computed cost for this line. */
  costUSD: number;
  /** True when `units` is an estimate rather than an actual billed amount. */
  estimated?: boolean;
}

export interface EvaluationReport {
  mode: TranslationMode;
  /** ISO timestamp when the report was generated. */
  generatedAt: string;
  /** Server-measured translation time in milliseconds. */
  processingMs: number;
  characters: {
    /** Source characters submitted / detected. */
    source?: number;
    /** Translated output characters (text view). */
    translated?: number;
    /** Actual characters billed by Document Translation (batch PDF). */
    charged?: number;
  };
  /** OCR pages analysed (text view / evaluation OCR). */
  pages?: number;
  /** Number of images translated (standalone image, layout mode). */
  images?: number;
  cost: {
    currency: string;
    region: string;
    items: CostItem[];
    totalUSD: number;
    /** True when at least one cost item is an estimate, not actual billed units. */
    estimated: boolean;
  };
}

/** Normalised set of measured units handed to {@link buildEvaluation}. */
export interface EvaluationInput {
  mode: TranslationMode;
  /** Server-measured translation time in milliseconds. */
  processingMs: number;
  prices?: Prices;
  // --- Text view ---
  ocrPages?: number;
  sourceCharacters?: number;
  translatedCharacters?: number;
  // --- Layout: PDF batch (actual billed characters) ---
  charactersCharged?: number;
  // --- Layout: standalone image ---
  images?: number;
  // --- Layout: office/text document (sync) — characters are an estimate ---
  estimatedDocumentCharacters?: number;
}

function line(
  label: string,
  units: number,
  unit: CostItem["unit"],
  unitPriceUSD: number,
  per: number,
  estimated?: boolean
): CostItem {
  return {
    label,
    units,
    unit,
    unitPriceUSD,
    per,
    costUSD: (units / per) * unitPriceUSD,
    estimated,
  };
}

/**
 * Builds a cost + performance report from the units measured for one
 * translation. Pure: pass in what was measured, get back a report.
 */
export function buildEvaluation(input: EvaluationInput): EvaluationReport {
  const prices = input.prices ?? DEFAULT_PRICES;
  const items: CostItem[] = [];

  if (input.mode === "text") {
    if (input.ocrPages != null) {
      items.push(
        line(
          "Document Intelligence — Read (OCR)",
          input.ocrPages,
          "pages",
          prices.docIntelReadPer1kPages,
          1000
        )
      );
    }
    if (input.sourceCharacters != null) {
      items.push(
        line(
          "Translator — Text translation",
          input.sourceCharacters,
          "characters",
          prices.textTranslatePerMChars,
          1_000_000
        )
      );
    }
  } else {
    // Layout mode: exactly one billing basis applies.
    if (input.charactersCharged != null) {
      items.push(
        line(
          "Translator — Document Translation",
          input.charactersCharged,
          "characters",
          prices.documentTranslatePerMChars,
          1_000_000
        )
      );
    } else if (input.images != null) {
      items.push(
        line(
          "Translator — Image translation",
          input.images,
          "images",
          prices.imageTranslatePer1kImages,
          1000
        )
      );
    } else if (input.estimatedDocumentCharacters != null) {
      items.push(
        line(
          "Translator — Document Translation (estimated)",
          input.estimatedDocumentCharacters,
          "characters",
          prices.documentTranslatePerMChars,
          1_000_000,
          true
        )
      );
    }
  }

  const totalUSD = items.reduce((sum, i) => sum + i.costUSD, 0);
  const estimated = items.some((i) => i.estimated);

  return {
    mode: input.mode,
    generatedAt: new Date().toISOString(),
    processingMs: input.processingMs,
    characters: {
      source: input.sourceCharacters ?? input.estimatedDocumentCharacters,
      translated: input.translatedCharacters,
      charged: input.charactersCharged,
    },
    pages: input.ocrPages,
    images: input.images,
    cost: {
      currency: prices.currency,
      region: prices.region,
      items,
      totalUSD,
      estimated,
    },
  };
}

// ---------------------------------------------------------------------------
// Display formatters (shared by client components)
// ---------------------------------------------------------------------------

/** Formats a USD amount with sensible precision for tiny per-doc costs. */
export function formatUSD(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

/** Formats a unit price as e.g. "$10.00 / 1M" or "$1.50 / 1K". */
export function formatUnitPrice(item: Pick<CostItem, "unitPriceUSD" | "per">): string {
  const batch = item.per >= 1_000_000 ? "1M" : "1K";
  return `${formatUSD(item.unitPriceUSD)} / ${batch}`;
}

/** Formats an elapsed duration in ms as "850 ms", "4.2 s" or "1m 5s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
}

/** Thousands-separated integer, e.g. 13690 -> "13,690". */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
