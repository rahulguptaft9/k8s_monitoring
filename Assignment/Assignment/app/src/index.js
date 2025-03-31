const express = require('express');
const promBundle = require('express-prom-bundle');
const { Pool } = require('pg');
const { trace } = require('@opentelemetry/api');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

// OpenTelemetry setup
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'http://tempo.monitoring.svc.cluster.local:4318/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()]
});

sdk.start();

const app = express();

// Prometheus metrics middleware
const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  includeUp: true,
  customLabels: { app: 'monitoring-demo' }
});

app.use(metricsMiddleware);

// Custom business metrics
const customMetrics = {
  dbQueryDuration: new promBundle.promClient.Histogram({
    name: 'db_query_duration_seconds',
    help: 'Duration of database queries in seconds',
    buckets: [0.1, 0.5, 1, 2, 5]
  }),
  activeConnections: new promBundle.promClient.Gauge({
    name: 'postgres_active_connections',
    help: 'Number of active database connections'
  }),
  rowsProcessed: new promBundle.promClient.Counter({
    name: 'db_rows_processed_total',
    help: 'Total number of rows processed'
  })
};

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Initialize database
async function initializeDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id SERIAL PRIMARY KEY,
        path VARCHAR(255),
        method VARCHAR(10),
        status_code INTEGER,
        response_time FLOAT,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } finally {
    client.release();
  }
}

initializeDb().catch(console.error);

// Middleware to track request metrics
app.use(async (req, res, next) => {
  const start = Date.now();
  res.on('finish', async () => {
    const duration = (Date.now() - start) / 1000;
    
    const tracer = trace.getTracer('demo-app');
    await tracer.startActiveSpan('store-request-metrics', async (span) => {
      try {
        const end = customMetrics.dbQueryDuration.startTimer();
        await pool.query(
          'INSERT INTO requests (path, method, status_code, response_time) VALUES ($1, $2, $3, $4)',
          [req.path, req.method, res.statusCode, duration]
        );
        end();
        customMetrics.rowsProcessed.inc();
      } catch (error) {
        span.recordException(error);
        console.error('Error storing metrics:', error);
      } finally {
        span.end();
      }
    });
  });
  next();
});

// Endpoints
app.get('/', async (req, res) => {
  const tracer = trace.getTracer('demo-app');
  
  await tracer.startActiveSpan('home-request', async (span) => {
    try {
      const end = customMetrics.dbQueryDuration.startTimer();
      const result = await pool.query('SELECT COUNT(*) FROM requests');
      end();
      
      res.json({
        message: 'Hello from monitoring demo!',
        totalRequests: parseInt(result.rows[0].count),
        timestamp: new Date()
      });
    } catch (error) {
      span.recordException(error);
      res.status(500).json({ error: 'Database error' });
    } finally {
      span.end();
    }
  });
});

// Database metrics endpoint
app.get('/metrics/db', async (req, res) => {
  const tracer = trace.getTracer('demo-app');
  
  await tracer.startActiveSpan('db-metrics', async (span) => {
    try {
      const activeConnectionsResult = await pool.query('SELECT count(*) FROM pg_stat_activity');
      customMetrics.activeConnections.set(parseInt(activeConnectionsResult.rows[0].count));
      
      const stats = await pool.query(`
        SELECT 
          count(*) as total_requests,
          avg(response_time) as avg_response_time,
          min(response_time) as min_response_time,
          max(response_time) as max_response_time
        FROM requests
      `);
      
      res.json({
        activeConnections: parseInt(activeConnectionsResult.rows[0].count),
        statistics: stats.rows[0]
      });
    } catch (error) {
      span.recordException(error);
      res.status(500).json({ error: 'Error fetching database metrics' });
    } finally {
      span.end();
    }
  });
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

const port = 3000;
app.listen(port, () => {
  console.log(`App listening at http://localhost:${port}`);
});