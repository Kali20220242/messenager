import { decode } from "base64-arraybuffer";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { Platform } from "react-native";
import { supabase } from "./supabase";


const AVATAR_BUCKET = "avatars";
const AVATAR_OUTPUT_SIZE = 512;
const AVATAR_SIGNED_URL_TTL_SECONDS = 60 * 60;
const AVATAR_SIGNED_URL_REFRESH_WINDOW_MS = 60 * 1000;
const SUPPORTED_INPUT_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

function inferExtension(asset: ImagePicker.ImagePickerAsset) {
  const fileName = asset.fileName ?? asset.uri.split("/").pop() ?? "avatar.jpg";
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension && extension.length <= 5 ? extension : "jpg";
}

function inferMimeType(asset: ImagePicker.ImagePickerAsset) {
  if (asset.mimeType) {
    return asset.mimeType.toLowerCase();
  }

  const extension = inferExtension(asset);
  switch (extension) {
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

function buildCropAction(asset: ImagePicker.ImagePickerAsset) {
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  const size = Math.min(width, height);

  if (size <= 0) {
    return null;
  }

  return {
    crop: {
      originX: Math.max(0, Math.floor((width - size) / 2)),
      originY: Math.max(0, Math.floor((height - size) / 2)),
      width: size,
      height: size,
    },
  } as const;
}

async function normalizeAvatarAsset(asset: ImagePicker.ImagePickerAsset) {

  const actions: ImageManipulator.Action[] = [];
  const crop = buildCropAction(asset);

  if (crop) {
    actions.push(crop);
  }

  actions.push({
    resize: {
      width: AVATAR_OUTPUT_SIZE,
      height: AVATAR_OUTPUT_SIZE,
    },
  });
  const normalized = await ImageManipulator.manipulateAsync(asset.uri, actions, {
    compress: 0.82,
    format: ImageManipulator.SaveFormat.JPEG,
  });

  if (Platform.OS === "web"){
    const response = await fetch(normalized.uri);
    return await response.arrayBuffer();
  } else {
    const base64 = await FileSystem.readAsStringAsync(normalized.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return decode(base64);
}};

export async function pickAndUploadAvatar(userId: string) {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.9,
  });

  if (result.canceled || !result.assets.length) {
    return null;
  }

  const asset = result.assets[0];
  const mimeType = inferMimeType(asset);

  if (mimeType && !SUPPORTED_INPUT_MIME_TYPES.has(mimeType)) {
    throw new Error("Please choose a JPG, PNG, WebP, or HEIC image.");
  }

  const filePath = `${userId}/${Date.now()}.jpg`;
  const fileBody = await normalizeAvatarAsset(asset);

  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(filePath, fileBody, {
    cacheControl: "3600",
    contentType: "image/jpeg",
    upsert: false,
  });

  if (error) {
    throw error;
  }

  return filePath;
}

const avatarUrlCache = new Map<string, { url: string; expiresAt: number }>();

export async function resolveAvatarUrl(path: string | null | undefined) {
  if (!path) {
    return null;
  }

  const now = Date.now();
  const cached = avatarUrlCache.get(path);

  if (cached && cached.expiresAt - now > AVATAR_SIGNED_URL_REFRESH_WINDOW_MS) {
    return cached.url;
  }

  const { data, error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(path, AVATAR_SIGNED_URL_TTL_SECONDS);

  if (error) {
    throw error;
  }

  avatarUrlCache.set(path, {
    url: data.signedUrl,
    expiresAt: now + AVATAR_SIGNED_URL_TTL_SECONDS * 1000,
  });

  return data.signedUrl;
}

export async function removeAvatarFiles(paths: Array<string | null | undefined>) {
  const uniquePaths = [...new Set(paths.map((path) => path?.trim()).filter(Boolean))] as string[];

  if (!uniquePaths.length) {
    return;
  }

  const { error } = await supabase.storage.from(AVATAR_BUCKET).remove(uniquePaths);

  if (error) {
    throw error;
  }

  for (const path of uniquePaths) {
    avatarUrlCache.delete(path);
  }
}
