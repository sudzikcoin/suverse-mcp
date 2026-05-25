/**
 * Single source of truth for the 12 paid SuVerse endpoints: HTTP path, published
 * price (micro-USDC), and how a `file_path` input maps onto the request body.
 * Prices + input shapes mirror the live x402 discovery definitions on api.suverse.io.
 */

export interface FileTarget {
  /** Body field for a PDF's base64 (e.g. "pdf_base64"), if the endpoint takes one. */
  pdfField?: string;
  /** Body field for an image's base64 (e.g. "image_base64"), if supported. */
  imageField?: string;
  /** If true, a file becomes one entry of a `files: [{data, media_type, name}]` array. */
  filesArray?: boolean;
}

export interface EndpointSpec {
  tool: string;
  path: string;
  priceMicro: number;
  description: string;
  /** Present iff the tool accepts a `file_path` input. */
  file?: FileTarget;
}

const PDF = { pdfField: "pdf_base64" } as const;
const PDF_OR_IMAGE = { pdfField: "pdf_base64", imageField: "image_base64" } as const;

export const ENDPOINTS: Record<string, EndpointSpec> = {
  freight_parse_ratecon: {
    tool: "freight_parse_ratecon",
    path: "/v1/freight/parse_ratecon",
    priceMicro: 100_000,
    description:
      "Parse a freight rate confirmation (PDF or text) into structured JSON: load #, " +
      "broker, rate, pickup/delivery stops, equipment.",
    file: PDF,
  },
  freight_parse_bol_pod: {
    tool: "freight_parse_bol_pod",
    path: "/v1/freight/parse_bol_pod",
    priceMicro: 150_000,
    description: "Parse a Bill of Lading / Proof of Delivery (PDF or text) into structured JSON.",
    file: PDF,
  },
  freight_parse_fuel_receipt: {
    tool: "freight_parse_fuel_receipt",
    path: "/v1/freight/parse_fuel_receipt",
    priceMicro: 50_000,
    description:
      "Parse a fuel receipt (text, PDF, or image) into structured JSON for IFTA / expense tracking.",
    file: PDF_OR_IMAGE,
  },
  freight_parse_w9: {
    tool: "freight_parse_w9",
    path: "/v1/freight/parse_w9",
    priceMicro: 70_000,
    description: "Parse an IRS Form W-9 (text, PDF, or image) into structured vendor-onboarding JSON.",
    file: PDF_OR_IMAGE,
  },
  freight_parse_insurance_cert: {
    tool: "freight_parse_insurance_cert",
    path: "/v1/freight/parse_insurance_cert",
    priceMicro: 80_000,
    description:
      "Parse an ACORD 25 Certificate of Insurance (text, PDF, or image) into structured JSON.",
    file: PDF_OR_IMAGE,
  },
  freight_parse_permit: {
    tool: "freight_parse_permit",
    path: "/v1/freight/parse_permit",
    priceMicro: 250_000,
    description:
      "Parse an oversize/overweight trucking permit (PDF or image) into structured JSON across " +
      "22 US states.",
    file: { filesArray: true },
  },
  freight_truck_route: {
    tool: "freight_truck_route",
    path: "/v1/freight/truck_route",
    priceMicro: 500_000,
    description:
      "Truck-legal routing between origin and destination with tolls, weigh stations, truck stops, " +
      "and turn-by-turn maneuvers.",
  },
  freight_calculate_tolls: {
    tool: "freight_calculate_tolls",
    path: "/v1/freight/calculate_tolls",
    priceMicro: 100_000,
    description: "Estimate tolls for a known route polyline given axle count and vehicle height.",
  },
  freight_trip_telematics: {
    tool: "freight_trip_telematics",
    path: "/v1/freight/trip_telematics",
    priceMicro: 10_000,
    description:
      "Compute trip analytics (distance, idle, harsh events, fuel burn) from an array of GPS pings.",
  },
  gov_query: {
    tool: "gov_query",
    path: "/v1/gov",
    priceMicro: 5_000,
    description:
      "Call any of SuVerse's 128 US-government data/search services by id (e.g. sec.company_info, " +
      "nps.parks). Use gov_list_services to discover ids + their params.",
  },
  gov_cms_open_payments: {
    tool: "gov_cms_open_payments",
    path: "/v1/gov/cms_open_payments",
    priceMicro: 10_000,
    description:
      "CMS Open Payments — industry payments to a physician by NPI and year " +
      "(params: physician_npi, year).",
  },
  gov_fbi_crime_data: {
    tool: "gov_fbi_crime_data",
    path: "/v1/gov/fbi_crime_data",
    priceMicro: 10_000,
    description:
      "FBI Crime Data Explorer — offense counts by state and year range " +
      "(params: state, offense, from_year, to_year).",
  },
};

export const PAID_TOOLS = Object.keys(ENDPOINTS);

/** A free, unauthenticated SuVerse endpoint the gov service catalog is read from. */
export const GOV_SERVICES_PATH = "/v1/gov/services";

export function microToUsd(micro: number): string {
  return (micro / 1_000_000).toFixed(micro % 10_000 === 0 ? 2 : 6);
}
