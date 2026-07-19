module.exports = {
  apps: [
    {
      name: 'property-api',
      script: 'dist/src/server.js',
      // Cluster mode spreads incoming connections across all CPU cores via
      // Node's built-in round-robin balancer - this is how a single VPS
      // handles "high-volume traffic" without needing multiple servers.
      exec_mode: 'cluster',
      instances: 'max',
      max_memory_restart: '400M',
      env_production: {
        NODE_ENV: 'production',
      },
      out_file: 'logs/api-out.log',
      error_file: 'logs/api-error.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'property-worker',
      script: 'dist/src/worker.js',
      // Fork mode, single instance: BullMQ workers already handle internal
      // concurrency (see queues/*.worker.ts `concurrency` option), and
      // running multiple worker PROCESSES to consume the same queue is
      // supported by BullMQ but unnecessary at this scale - one process
      // with concurrency:5-10 comfortably saturates a simulated third party.
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '300M',
      env_production: {
        NODE_ENV: 'production',
      },
      out_file: 'logs/worker-out.log',
      error_file: 'logs/worker-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
