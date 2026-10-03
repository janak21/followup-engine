const ANON_FLAG = "ALLOW_ANON_TENANT";

export function assertSafeEnv() {
  if (process.env.NODE_ENV === "production" && process.env[ANON_FLAG] === "1") {
    throw new Error(
      `Unsafe environment: ${ANON_FLAG}=1 is set while NODE_ENV=production. ` +
        "This flag is a full authentication bypass and must NEVER be enabled in production."
    );
  }
}