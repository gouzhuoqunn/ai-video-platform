import { notFound } from "next/navigation";
import { GenerationProfilePage } from "@/components/GenerationProfilePage";
import type { GpuProfileKey } from "@/lib/generation/gpu-profiles";

type ProfilePageProps = {
  params: Promise<{ profile: string }>;
};

export function generateStaticParams() {
  return [{ profile: "4090" }, { profile: "5090" }];
}

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { profile } = await params;
  const profileKey = profile === "4090" ? "rtx4090" : profile === "5090" ? "rtx5090" : null;
  if (!profileKey) notFound();
  return <GenerationProfilePage profile={profileKey as GpuProfileKey} />;
}
