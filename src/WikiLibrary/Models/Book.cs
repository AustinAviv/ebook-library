namespace WikiLibrary.Models;

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string? Author { get; set; }
    public string? Description { get; set; }
    public string? Category { get; set; }
    public int Year { get; set; }
    public string? Language { get; set; }
    public int Pages { get; set; }
    public long FileSize { get; set; }
    public string BlobPathname { get; set; } = "";
    public string? Url { get; set; }
    public string? DownloadUrl { get; set; }
    public bool IsCommunityPublished { get; set; }
    public string? StorageFilePath { get; set; }
    public long? SubmissionId { get; set; }

    public bool HasAuthor => !string.IsNullOrWhiteSpace(Author) && !Author.Equals("Unknown author", StringComparison.OrdinalIgnoreCase);
    public bool HasCategory => !string.IsNullOrWhiteSpace(Category) && !Category.Equals("Uncategorized", StringComparison.OrdinalIgnoreCase);
    public bool HasDescription => !string.IsNullOrWhiteSpace(Description) && !Description.Equals("No description yet.", StringComparison.OrdinalIgnoreCase);

    public string EffectiveDownloadUrl => !string.IsNullOrWhiteSpace(DownloadUrl) ? DownloadUrl : $"/api/download?id={Id}";
    public string EffectiveViewUrl => !string.IsNullOrWhiteSpace(Url) ? Url : (!string.IsNullOrWhiteSpace(DownloadUrl) ? DownloadUrl : $"/api/download?id={Id}&view=1");

    public string FileSizeText
    {
        get
        {
            if (FileSize <= 0) return "-";
            double mb = FileSize / (1024.0 * 1024.0);
            if (mb >= 1.0)
                return $"{mb:F1} MB";
            double kb = FileSize / 1024.0;
            return $"{kb:F0} KB";
        }
    }

    public string YearText => Year > 0 ? Year.ToString() : "-";
    public string PagesText => Pages > 0 ? Pages.ToString("N0") : "-";
}
