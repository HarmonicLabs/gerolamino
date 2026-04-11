import { Schema } from "effect";

import {
  MultiplexerConfigSchema,
  MultiplexerHeaderSchema,
  MultiplexerMessageSchema,
  MultiplexerProtocolTypeSchema,
} from "./Schemas";

/**
 * Type definitions derived from schemas
 */
export type MultiplexerProtocolType = typeof MultiplexerProtocolTypeSchema.Type;
export type MultiplexerHeader = typeof MultiplexerHeaderSchema.Type;
export type MultiplexerMessage = typeof MultiplexerMessageSchema.Type;
export type MultiplexerConfig = typeof MultiplexerConfigSchema.Type;
