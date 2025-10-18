import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { signIn } from "@/app/(auth)/auth";
import { isDevelopmentEnvironment } from "@/lib/constants";

export async function GET(request: Request) {
  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  // If already has session, return success
  if (token) {
    return NextResponse.json({ success: true, session: token });
  }

  // Create guest session without redirect
  try {
    await signIn("guest", { redirect: false });
    return NextResponse.json({ success: true, message: "Guest session created" });
  } catch (error) {
    return NextResponse.json({ success: false, error: "Failed to create guest session" }, { status: 500 });
  }
}
