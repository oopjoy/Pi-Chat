/** Shared transport budgets enforced at the HTTP/image and RPC boundaries. */
export const MAX_PROMPT_IMAGES = 10;
export const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PROMPT_IMAGES_TOTAL_BYTES = 40 * 1024 * 1024;

/** Worst-case separately padded Base64 payloads at the aggregate raw-image cap. */
export const MAX_PROMPT_IMAGE_ENCODED_BYTES =
  Math.ceil(MAX_PROMPT_IMAGE_BYTES / 3) * 4;
export const MAX_PROMPT_IMAGES_ENCODED_BYTES =
  Math.ceil(MAX_PROMPT_IMAGES_TOTAL_BYTES / 3) * 4 + MAX_PROMPT_IMAGES * 4;

/** A 40 MiB image set expands to about 53.4 MiB before its JSON envelope. */
export const MAX_RPC_OUTBOUND_LINE_BYTES = 64 * 1024 * 1024;
/** Pi may echo a prompt inside an event/response with a modestly larger envelope. */
export const MAX_RPC_INBOUND_LINE_BYTES = MAX_RPC_OUTBOUND_LINE_BYTES + 1024 * 1024;

/** Reserve room for request IDs, JSON property names, escaping, and newline. */
export const RPC_OUTBOUND_ENVELOPE_RESERVE_BYTES = 1024 * 1024;
/** HTTP JSON must fit before it can be decoded and checked against RPC budgets. */
export const MAX_PROMPT_HTTP_BODY_BYTES =
  MAX_RPC_OUTBOUND_LINE_BYTES - RPC_OUTBOUND_ENVELOPE_RESERVE_BYTES;
