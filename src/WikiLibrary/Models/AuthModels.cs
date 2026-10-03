using System.Text.Json.Serialization;

namespace WikiLibrary.Models;

public class AppConfig
{
    [JsonPropertyName("supabaseUrl")]
    public string? SupabaseUrl { get; set; }

    [JsonPropertyName("supabaseAnonKey")]
    public string? SupabaseAnonKey { get; set; }

    [JsonPropertyName("ownerEmail")]
    public string? OwnerEmail { get; set; }
}

public class SupabaseUser
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("email")]
    public string Email { get; set; } = "";

    [JsonPropertyName("role")]
    public string Role { get; set; } = "user";

    public bool IsOwner => string.Equals(Role, "owner", StringComparison.OrdinalIgnoreCase) ||
                           string.Equals(Role, "admin", StringComparison.OrdinalIgnoreCase);
}

public class SupabaseAuthResult
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("user")]
    public SupabaseUser? User { get; set; }

    [JsonPropertyName("session")]
    public bool HasSession { get; set; }
}

public class FileUploadResult
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("filePath")]
    public string? FilePath { get; set; }

    [JsonPropertyName("publicUrl")]
    public string? PublicUrl { get; set; }

    [JsonPropertyName("fileSize")]
    public long FileSize { get; set; }
}

public class SubmissionOperationResult
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("submission")]
    public BookSubmission? Submission { get; set; }
}
