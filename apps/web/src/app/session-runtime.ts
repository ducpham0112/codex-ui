export async function loadSessionRuntime(rpc: (method: string, params: any) => Promise<any>, threadId: string): Promise<any> {
  try {
    const result = await rpc("thread/resume", { threadId });
    return { ...result, thread: { ...result.thread, externalWriter: false } };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already has an active writer")) throw error;
    const result = await rpc("thread/read", { threadId, includeTurns: true });
    return { ...result, thread: { ...result.thread, externalWriter: true } };
  }
}
