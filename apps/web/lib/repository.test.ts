import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryWaitlistRepository, setWaitlistRepository, getWaitlistRepository } from './repository';

describe('InMemoryWaitlistRepository', () => {
  let repo: InMemoryWaitlistRepository;

  beforeEach(() => {
    repo = new InMemoryWaitlistRepository();
  });

  it('adds an email and returns success', async () => {
    const result = await repo.add('test@example.com');
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('normalizes email to lowercase', async () => {
    await repo.add('Test@Example.COM');
    const entries = await repo.list();
    expect(entries[0].email).toBe('test@example.com');
  });

  it('rejects duplicate emails', async () => {
    await repo.add('test@example.com');
    const result = await repo.add('test@example.com');
    expect(result.success).toBe(false);
    expect(result.error).toContain('already');
  });

  it('lists all entries', async () => {
    await repo.add('a@example.com');
    await repo.add('b@example.com');
    const entries = await repo.list();
    expect(entries).toHaveLength(2);
  });
});

describe('WaitlistRepository registry', () => {
  it('uses in-memory by default', () => {
    const repo = getWaitlistRepository();
    expect(repo).toBeInstanceOf(InMemoryWaitlistRepository);
  });

  it('allows injection of a custom repository', async () => {
    const mock: InMemoryWaitlistRepository = new InMemoryWaitlistRepository();
    setWaitlistRepository(mock);
    const result = await getWaitlistRepository().add('custom@example.com');
    expect(result.success).toBe(true);
  });
});
