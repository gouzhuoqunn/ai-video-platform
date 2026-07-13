export type VideoJobStatus = "pending_confirmation" | "queued" | "processing" | "succeeded" | "failed" | "canceled";

export type VideoJobPriority = "normal" | "urgent";

export type VideoModelKey = "lightweight-video" | "standard-video" | "high-quality-video";

export type AvailableVideoModelKey = Exclude<VideoModelKey, "high-quality-video">;

export type CreditTransactionType =
  | "signup_bonus"
  | "generation_charge"
  | "generation_refund"
  | "purchase"
  | "admin_adjustment";

export type VideoJobProgress = {
  status: VideoJobStatus;
  progress: number;
};

export type VideoJob = {
  id: string;
  user_id: string;
  prompt: string;
  model_key: AvailableVideoModelKey;
  status: VideoJobStatus;
  duration_seconds: number;
  resolution: "480p" | "720p";
  cost_credits: number;
  reference_image_path: string | null;
  output_video_url: string | null;
  thumbnail_url: string | null;
  thumbnail_path: string | null;
  thumbnail_status: "pending" | "ready" | "failed" | "default";
  error_message: string | null;
  progress: number;
  priority: VideoJobPriority;
  confirmed_at: string | null;
  queued_at: string | null;
  deleted_at: string | null;
  deletion_cleanup_status: "none" | "pending" | "complete" | "retry";
  deletion_cleanup_error: string | null;
  generation_group_id: string | null;
  generation_number: number;
  parent_job_id: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  max_attempts: number;
  output_video_path: string | null;
  output_size_bytes: number | null;
  output_mime_type: string | null;
  charged_at: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type VideoJobWithBalance = VideoJob & {
  latest_balance: number;
};

export type WorkerJob = Pick<
  VideoJob,
  | "id"
  | "user_id"
  | "prompt"
  | "model_key"
  | "status"
  | "duration_seconds"
  | "resolution"
  | "cost_credits"
  | "progress"
  | "attempt_count"
  | "max_attempts"
  | "output_video_path"
  | "output_mime_type"
  | "worker_id"
  | "lease_expires_at"
  | "created_at"
  | "started_at"
>;

export type SignedVideoResponse = {
  signedUrl: string;
  expiresIn: number;
  mimeType: string;
  filename: string;
};
