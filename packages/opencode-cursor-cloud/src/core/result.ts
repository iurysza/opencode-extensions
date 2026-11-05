export type Result<T, E> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ _tag: "ok", value });
export const err = <E>(error: E): Result<never, E> => ({ _tag: "err", error });
