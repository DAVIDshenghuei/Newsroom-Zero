import { NextRequest, NextResponse } from 'next/server';
import { getWaitlistRepository } from '@/lib/repository';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const email: string | undefined = body?.email;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return NextResponse.json(
      { success: false, error: 'Please provide a valid email address.' },
      { status: 400 },
    );
  }

  const repo = getWaitlistRepository();
  const result = await repo.add(email);

  if (!result.success) {
    return NextResponse.json(result, { status: 409 });
  }

  return NextResponse.json(result, { status: 201 });
}
