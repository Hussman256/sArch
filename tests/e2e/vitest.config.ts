import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * Runs the files in name order. The last one changes the config every other
 * file reads, and puts it back when it is done.
 */
class InNameOrder extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The tests share one chain and one config account, and some of them
    // change that config, so files run one after another.
    fileParallelism: false,
    sequence: { sequencer: InNameOrder },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
