/**
 * x402 v2 buyer wired to Base USDC.
 *
 * Pattern follows coinbase/x402 examples/typescript/clients/axios: build an
 * `x402Client` with a payment selector, register the EVM "exact" scheme
 * (EIP-3009 transferWithAuthorization signing via a viem account), and wrap axios
 * so a 402 challenge is paid + retried transparently. Our selector also ENFORCES
 * the per-call cap (min of the global SUVERSE_MAX_PAYMENT_USDC and the tool's
 * published price) — a call can never overpay or pay for an unexpected price.
 */
import { x402Client, wrapAxiosWithPayment, x402HTTPClient } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import axios from "axios";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import type { Config } from "./config.js";
import { microToUsd } from "./endpoints.js";
import { log } from "./logger.js";

export class PaymentCapError extends Error {}
export class NoBasePaymentOption extends Error {}

/** Minimal shape we read from each advertised payment option. */
interface PaymentOption {
  network: string;
  amount: string;
  asset?: string;
  scheme?: string;
}

export interface PaidResult {
  data: unknown;
  settle?: unknown;
}

/** HTTP surface the tools depend on — injectable so tests need no chain/network. */
export interface SuverseHttp {
  address: `0x${string}`;
  paidRequest(path: string, body: unknown, expectedMicro: number, idempotencyKey: string): Promise<PaidResult>;
  freeGet(path: string): Promise<unknown>;
  usdcBalanceMicro(): Promise<bigint>;
}

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const REQUEST_TIMEOUT_MS = 120_000;

export function createSuverseHttp(cfg: Config): SuverseHttp {
  const account = privateKeyToAccount(cfg.privateKey);
  const rpcOptions = cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : undefined;
  const freeAxios = axios.create({ baseURL: cfg.apiBase, timeout: REQUEST_TIMEOUT_MS });
  const publicClient = createPublicClient({ chain: base, transport: http(cfg.rpcUrl) });

  return {
    address: account.address,

    async paidRequest(path, body, expectedMicro, idempotencyKey): Promise<PaidResult> {
      const capMicro = Math.min(cfg.maxPaymentMicro, expectedMicro);

      // Selector: choose the Base (eip155) option and refuse to overpay.
      const selectPayment = (_version: number, options: PaymentOption[]): PaymentOption => {
        const evm = options.find((o) => String(o.network).startsWith("eip155:"));
        if (!evm) {
          throw new NoBasePaymentOption(
            "SuVerse offered no Base (eip155) payment option for this call.",
          );
        }
        const amt = Number(evm.amount);
        if (!Number.isFinite(amt)) {
          throw new PaymentCapError(`Unparseable payment amount from server: "${evm.amount}".`);
        }
        if (amt > capMicro) {
          throw new PaymentCapError(
            `Quoted ${microToUsd(amt)} USDC exceeds the allowed ${microToUsd(capMicro)} for this ` +
              `call (cap = min of SUVERSE_MAX_PAYMENT_USDC and the tool's published price).`,
          );
        }
        return evm;
      };

      // x402Client's selector is typed against its own PaymentRequirements; we read
      // only network/amount, so adapt structurally.
      const client = new x402Client(selectPayment as never);
      client.register("eip155:*", new ExactEvmScheme(account, rpcOptions));

      // Fresh axios instance per call so payment interceptors never stack.
      const inst = axios.create({ baseURL: cfg.apiBase, timeout: REQUEST_TIMEOUT_MS });
      const api = wrapAxiosWithPayment(inst, client);
      const res = await api.post(path, body, { headers: { "Idempotency-Key": idempotencyKey } });

      let settle: unknown;
      try {
        settle = new x402HTTPClient(client).getPaymentSettleResponse(
          (name: string) => res.headers[name.toLowerCase()],
        );
      } catch {
        // Settlement receipt is best-effort telemetry.
      }
      log.info("paid call settled", { path, settle });
      return { data: res.data, settle };
    },

    async freeGet(path): Promise<unknown> {
      const res = await freeAxios.get(path);
      return res.data;
    },

    async usdcBalanceMicro(): Promise<bigint> {
      const bal = await publicClient.readContract({
        address: cfg.usdcAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      return bal as bigint;
    },
  };
}
