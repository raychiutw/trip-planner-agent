import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    clearMocks: true,
    restoreMocks: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,js}'],
    exclude: ['node_modules/**', '.claude/**'],
    // 部分測試會 spawn 真子程序（git、shell），機器吃緊時 5 秒預設會間歇逾時
    testTimeout: 30000,
  },
});
