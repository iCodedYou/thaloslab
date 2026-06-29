import open from 'open';

export async function openUi(url: string): Promise<void> {
  await open(url);
}
