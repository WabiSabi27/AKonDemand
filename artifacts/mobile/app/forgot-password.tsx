import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useState } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { forgotBusinessPassword } from "@workspace/api-client-react";

/**
 * Provider "forgot password" — asks for the account email and requests a
 * single-use reset link. The server always answers OK (no account
 * enumeration), so the confirmation screen is unconditional.
 */
export default function ForgotPasswordScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Please enter your account email.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await forgotBusinessPassword({ email: trimmed });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSent(true);
    } catch {
      setError("Could not reach the server. Please try again.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
      <StatusBar style="light" />
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={styles.backRow} onPress={() => router.replace("/login")}>
          <Feather name="arrow-left" size={18} color="rgba(255,255,255,0.7)" />
          <Text style={styles.backText}>Back to Sign In</Text>
        </TouchableOpacity>

        {sent ? (
          <View style={styles.content}>
            <View style={[styles.iconCircle, { backgroundColor: "rgba(76,175,80,0.15)" }]}>
              <Feather name="mail" size={40} color="#66BB6A" />
            </View>
            <Text style={styles.title}>Check your email</Text>
            <Text style={styles.desc}>
              If a provider account exists for{" "}
              <Text style={{ color: "#fff", fontWeight: "700" }}>{email.trim()}</Text>, we've sent a
              password-reset link. It works once and expires in 1 hour.
            </Text>
            <Text style={[styles.desc, { fontSize: 13 }]}>
              Don't see it? Check your spam folder, or try again in a few minutes.
            </Text>
          </View>
        ) : (
          <View style={styles.content}>
            <View style={[styles.iconCircle, { backgroundColor: "rgba(92,107,192,0.18)" }]}>
              <Feather name="key" size={40} color="#7986CB" />
            </View>
            <Text style={styles.title}>Forgot your password?</Text>
            <Text style={styles.desc}>
              Enter your provider account email and we'll send you a link to choose a new password.
            </Text>

            <View style={{ width: "100%", marginTop: 8 }}>
              <Text style={styles.fieldLabel}>Email Address</Text>
              <View style={styles.inputRow}>
                <Feather name="mail" size={16} color="rgba(255,255,255,0.5)" />
                <TextInput
                  style={styles.input}
                  placeholder="your@business.com"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoFocus={Platform.OS === "web"}
                  onSubmitEditing={handleSubmit}
                />
              </View>
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </View>

            <TouchableOpacity
              style={[styles.btn, { backgroundColor: "#5C6BC0", opacity: loading ? 0.7 : 1 }]}
              onPress={handleSubmit}
              activeOpacity={0.85}
              disabled={loading}
            >
              <Text style={styles.btnText}>{loading ? "Sending…" : "Send Reset Link"}</Text>
              {!loading && <Feather name="arrow-right" size={18} color="#fff" />}
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0F1B2D", paddingHorizontal: 28 },
  scroll: { flexGrow: 1, justifyContent: "center" },
  backRow: {
    position: "absolute",
    top: 4,
    left: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 8,
  },
  backText: { color: "rgba(255,255,255,0.7)", fontSize: 14, fontWeight: "600" },
  content: { alignItems: "center", gap: 16, width: "100%" },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: { color: "#fff", fontSize: 22, fontWeight: "700", textAlign: "center" },
  desc: { color: "rgba(255,255,255,0.6)", fontSize: 15, lineHeight: 24, textAlign: "center" },
  fieldLabel: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "600", marginBottom: 8 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "web" ? 12 : 10,
  },
  input: { flex: 1, color: "#fff", fontSize: 15, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : null) },
  errorText: { color: "#EF9A9A", fontSize: 13, marginTop: 8 },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 16,
    width: "100%",
    marginTop: 8,
  },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
