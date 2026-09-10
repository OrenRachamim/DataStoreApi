/**
 * Test seams. All undefined in production. Tests set them to inject a crash at
 * a precise point of the upload flow (see TESTS.md IDEM-02..04, PAY-12).
 */
export const testHooks: {
  beforeStore?: (itemId: string) => Promise<void> | void;
  beforeSettle?: (itemId: string) => Promise<void> | void;
  afterSettle?: (itemId: string) => Promise<void> | void;
  /** Return true to make one conditional metadata write behave as if it lost the race. */
  dropMetaWrite?: (meta: unknown) => boolean;
  /** Called by the expiry sweep before each marker is processed; may throw to simulate a failure. */
  beforeExpiryDelete?: (markerKey: string) => Promise<void> | void;
  /** Return true to make a named rate limit deny the next check. */
  forceRateLimit?: (name: string) => boolean;
} = {};
