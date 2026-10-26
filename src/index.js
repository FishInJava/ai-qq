import { start } from './runtime/index.js';
import { AppError } from './errors.js';

try {
  await start();
} catch (err) {
  if (err instanceof AppError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.code === 'already_running' ? 1 : 42);
  }
  const error = err instanceof Error ? err : new Error(String(err));
  process.stderr.write(`服务启动失败：${error.message}\n`);
  process.exit(42);
}
