/**
 * Test seams. All undefined in production. Tests set them to inject a crash at
 * a precise point of the upload flow (see TESTS.md IDEM-02..04, PAY-12).
 */
export const testHooks: {
  beforeStore?: (itemId: string) => Promise<void> | void;
  beforeSettle?: (itemId: string) => Promise<void> | void;
  afterSettle?: (itemId: string) => Promise<void> | void;
} = {};
