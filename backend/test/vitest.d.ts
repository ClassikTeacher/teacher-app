declare module 'vitest' {
  export interface ProvidedContext {
    TEST_PG_ADMIN_URL: string;
    TEST_PG_TEMPLATE: string;
    TEST_REDIS_URL: string;
    TEST_S3_ENDPOINT: string;
    TEST_S3_ACCESS_KEY: string;
    TEST_S3_SECRET_KEY: string;
  }
}

export {};
