using UnrealBuildTool;
public class QCoderIBridge : ModuleRules
{
    public QCoderIBridge(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        PrivateDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine", "UnrealEd", "Json", "JsonUtilities",
            "AssetRegistry", "AssetTools", "UMG", "UMGEditor", "Slate", "SlateCore",
            "BlueprintGraph", "Kismet", "KismetCompiler", "MaterialEditor", "RHI"
        });
    }
}
