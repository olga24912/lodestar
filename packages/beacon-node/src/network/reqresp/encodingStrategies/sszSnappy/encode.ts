import varint from "varint";
import {source} from "stream-to-it";
import snappy from "@chainsafe/snappy-stream";
import {RequestOrOutgoingResponseBody, OutgoingSerializer} from "../../types.js";
import {SszSnappyError, SszSnappyErrorCode} from "./errors.js";

/**
 * ssz_snappy encoding strategy writer.
 * Yields byte chunks for encoded header and payload as defined in the spec:
 * ```
 * <encoding-dependent-header> | <encoded-payload>
 * ```
 */
export async function* writeSszSnappyPayload<T extends RequestOrOutgoingResponseBody>(
  body: T,
  serializer: OutgoingSerializer
): AsyncGenerator<Buffer> {
  const serializedBody = serializeSszBody(body, serializer);

  yield* encodeSszSnappy(serializedBody);
}

/**
 * Buffered Snappy writer
 */
export async function* encodeSszSnappy(bytes: Buffer): AsyncGenerator<Buffer> {
  // MUST encode the length of the raw SSZ bytes, encoded as an unsigned protobuf varint
  yield Buffer.from(varint.encode(bytes.length));

  // By first computing and writing the SSZ byte length, the SSZ encoder can then directly
  // write the chunk contents to the stream. Snappy writer compresses frame by frame

  const stream = snappy.createCompressStream();
  stream.write(bytes);
  stream.end();
  yield* source<Buffer>(stream);
}

/**
 * Returns SSZ serialized body. Wrapps errors with SszSnappyError.SERIALIZE_ERROR
 */
function serializeSszBody<T extends RequestOrOutgoingResponseBody>(body: T, serializer: OutgoingSerializer): Buffer {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bytes = serializer.serialize(body as any);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  } catch (e) {
    throw new SszSnappyError({code: SszSnappyErrorCode.SERIALIZE_ERROR, serializeError: e as Error});
  }
}
