// Production-grade logging utility
const createLogger = (name: string) => {
  const prefix = `[${new Date().toLocaleTimeString()}] [${name}]`;
  
  return {
    info: (message: string, data?: any) => {
      if (data) {
        console.log(`${prefix} ${message}`, data);
      } else {
        console.log(`${prefix} ${message}`);
      }
    },
    warn: (message: string, data?: any) => {
      if (data) {
        console.warn(`${prefix} ⚠️ ${message}`, data);
      } else {
        console.warn(`${prefix} ⚠️ ${message}`);
      }
    },
    error: (message: string, error?: any) => {
      if (error) {
        console.error(`${prefix} ❌ ${message}`, error);
      } else {
        console.error(`${prefix} ❌ ${message}`);
      }
    },
    debug: (message: string, data?: any) => {
      if (process.env.NODE_ENV !== 'production') {
        if (data) {
          console.debug(`${prefix} 🐛 ${message}`, data);
        } else {
          console.debug(`${prefix} 🐛 ${message}`);
        }
      }
    },
    success: (message: string, data?: any) => {
      if (data) {
        console.log(`${prefix} ✅ ${message}`, data);
      } else {
        console.log(`${prefix} ✅ ${message}`);
      }
    }
  };
};

// Default logger
export const logger = createLogger('LiquiBot');

// Named loggers
export const apiLogger = createLogger('API');
export const tradingLogger = createLogger('Trading');
export const dbLogger = createLogger('Database');
export const aiLogger = createLogger('AI');
