// Rate limiting policies for LiquiBot's public HTTP endpoints.
import rateLimit from 'express-rate-limit';

const jsonRateLimitHandler = (req: any, res: any) => {
  res.status(429).json({
    success: false,
    error: 'Too many requests, please try again later.',
  });
};

// Strict: protects the EA key-validation endpoint from brute-force guessing.
export const eaValidateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler,
});

// Moderate: user-triggered actions (manual orders, config changes).
export const userActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler,
});

// Lenient: legitimate EA polling endpoints hit frequently by design.
export const eaPollingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler,
});
