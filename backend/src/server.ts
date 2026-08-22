// Importing config first ensures env vars are validated (and the process
// exits with a clear error) before the server ever starts listening.
import { config } from './config';
import app from './app';

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server listening at http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Connected DB target: ${config.db.host}/${config.db.database}`);
});
