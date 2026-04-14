import "react-native-url-polyfill/auto";

import { StatusBar } from "expo-status-bar";
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { env } from "./src/lib/env";

const sections = [
  {
    eyebrow: "Backend",
    title: "Rust API",
    body: "Axum API with SQLx and Supabase Postgres connectivity.",
  },
  {
    eyebrow: "Client",
    title: "Expo Mobile App",
    body: "React Native application prepared for auth, chat list, and room flow.",
  },
  {
    eyebrow: "Data",
    title: "Supabase",
    body: "RLS policies, auth integration, and realtime-ready schema in /supabase.",
  },
];

export default function App() {
  const projectState = [
    `Supabase URL: ${env.EXPO_PUBLIC_SUPABASE_URL}`,
    "Auth storage: expo-secure-store",
    "State layer: zustand",
  ];

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Text style={styles.kicker}>Messenger / Bootstrap</Text>
          <Text style={styles.title}>Mobile shell is connected to the project foundation.</Text>
          <Text style={styles.subtitle}>
            This screen is intentionally minimal: it confirms environment wiring before auth,
            conversations, and realtime transport are added.
          </Text>
        </View>

        <View style={styles.grid}>
          {sections.map((section) => (
            <View key={section.title} style={styles.card}>
              <Text style={styles.eyebrow}>{section.eyebrow}</Text>
              <Text style={styles.cardTitle}>{section.title}</Text>
              <Text style={styles.cardBody}>{section.body}</Text>
            </View>
          ))}
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Current wiring</Text>
          {projectState.map((line) => (
            <Text key={line} style={styles.panelItem}>
              {line}
            </Text>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f7f1e7",
  },
  content: {
    gap: 20,
    paddingHorizontal: 20,
    paddingVertical: 32,
  },
  hero: {
    backgroundColor: "#1f2a44",
    borderRadius: 28,
    gap: 12,
    padding: 24,
  },
  kicker: {
    color: "#c6d4ff",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  title: {
    color: "#fffaf2",
    fontSize: 32,
    fontWeight: "800",
    lineHeight: 38,
  },
  subtitle: {
    color: "#d9e0f1",
    fontSize: 15,
    lineHeight: 23,
  },
  grid: {
    gap: 14,
  },
  card: {
    backgroundColor: "#fffaf2",
    borderColor: "#e1d6c4",
    borderRadius: 22,
    borderWidth: 1,
    gap: 8,
    padding: 20,
  },
  eyebrow: {
    color: "#8c5e34",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
  cardTitle: {
    color: "#182033",
    fontSize: 22,
    fontWeight: "800",
  },
  cardBody: {
    color: "#475066",
    fontSize: 15,
    lineHeight: 22,
  },
  panel: {
    backgroundColor: "#d8e6ff",
    borderRadius: 24,
    gap: 10,
    padding: 20,
  },
  panelTitle: {
    color: "#11203d",
    fontSize: 18,
    fontWeight: "800",
  },
  panelItem: {
    color: "#21345e",
    fontSize: 14,
    lineHeight: 20,
  },
});
