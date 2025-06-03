import jwt from "jsonwebtoken";

export interface TranscribeJwtPayload {
  sub: string;
  aud: "transcribe";
  exp: number;
}

export function verifyJwt(token: string): TranscribeJwtPayload {
  const secret = process.env.TRANSCRIBE_JWT_SECRET;
  if (!secret) throw new Error("TRANSCRIBE_JWT_SECRET not set");
  return jwt.verify(token, secret) as TranscribeJwtPayload;
} 