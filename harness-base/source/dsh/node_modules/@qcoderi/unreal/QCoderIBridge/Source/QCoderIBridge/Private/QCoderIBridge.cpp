#include "Modules/ModuleManager.h"
#include "Containers/Ticker.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "HAL/FileManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Editor.h"
#include "LevelEditorViewport.h"
#include "ImageUtils.h"
#include "UnrealClient.h"
#include "DynamicRHI.h"
#include "Camera/CameraComponent.h"
#include "Components/LightComponent.h"
#include "Components/LocalLightComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Animation/AnimSequenceBase.h"
#include "Animation/Skeleton.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/PostProcessVolume.h"
#include "ScopedTransaction.h"
#include "Subsystems/EditorActorSubsystem.h"
#include "Subsystems/EditorAssetSubsystem.h"
#include "FileHelpers.h"
#include "Engine/World.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/StaticMesh.h"
#include "Engine/Texture2D.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Font.h"
#include "Engine/FontFace.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetToolsModule.h"
#include "AssetImportTask.h"
#include "Factories/BlueprintFactory.h"
#include "Factories/FbxFactory.h"
#include "Factories/FbxImportUI.h"
#include "Factories/FbxStaticMeshImportData.h"
#include "Factories/MaterialFactoryNew.h"
#include "Factories/TextureFactory.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionTextureSample.h"
#include "WidgetBlueprintFactory.h"
#include "WidgetBlueprint.h"
#include "Blueprint/WidgetTree.h"
#include "Blueprint/UserWidget.h"
#include "Components/CanvasPanel.h"
#include "Components/CanvasPanelSlot.h"
#include "Components/ContentWidget.h"
#include "Components/TextBlock.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Kismet2/CompilerResultsLog.h"
#include "EdGraphSchema_K2.h"
#include "K2Node_CallFunction.h"
#include "K2Node_Event.h"
#include "K2Node_ComponentBoundEvent.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "UObject/UnrealType.h"

namespace QC
{
using FJson = TSharedPtr<FJsonObject>;
struct FReply { bool Ok; FJson Data; FString Error; };
FJson Obj() { return MakeShared<FJsonObject>(); }
FReply Good(FJson Data) { return { true, Data, TEXT("") }; }
FReply Fail(const FString& Error) { return { false, Obj(), Error }; }
FString S(FJson J, const TCHAR* Key, const FString& Default = TEXT("")) { FString V; return J->TryGetStringField(Key, V) ? V : Default; }
double N(FJson J, const TCHAR* Key, double Default = 0) { double V; return J->TryGetNumberField(Key, V) ? V : Default; }
bool B(FJson J, const TCHAR* Key, bool Default = false) { bool V; return J->TryGetBoolField(Key, V) ? V : Default; }
TSharedPtr<FJsonValue> JV(FJson J) { return MakeShared<FJsonValueObject>(J); }
FJson Path(UObject* Object) { FJson R = Obj(); R->SetStringField(TEXT("path"), Object->GetPathName()); R->SetStringField(TEXT("class"), Object->GetClass()->GetPathName()); return R; }
bool Write(const FString& File, FJson J)
{
    FString Text; auto Writer = TJsonWriterFactory<>::Create(&Text); FJsonSerializer::Serialize(J.ToSharedRef(), Writer);
    const FString Temp = File + TEXT(".tmp");
    return FFileHelper::SaveStringToFile(Text, *Temp, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) && IFileManager::Get().Move(*File, *Temp, true, true);
}
FJson Read(const FString& File)
{
    FString Text; FJson J;
    if (IFileManager::Get().FileSize(*File) > 262144 || !FFileHelper::LoadFileToString(Text, *File)) return nullptr;
    return FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), J) ? J : nullptr;
}
FVector V(FJson J, const TCHAR* Key, FVector Default = FVector::ZeroVector)
{
    const TArray<TSharedPtr<FJsonValue>>* Values;
    if (!J->TryGetArrayField(Key, Values) || Values->Num() != 3) return Default;
    double X, Y, Z;
    return (*Values)[0]->TryGetNumber(X) && (*Values)[1]->TryGetNumber(Y) && (*Values)[2]->TryGetNumber(Z) ? FVector(X, Y, Z) : Default;
}
TArray<TSharedPtr<FJsonValue>> Vec(FVector X) { return { MakeShared<FJsonValueNumber>(X.X), MakeShared<FJsonValueNumber>(X.Y), MakeShared<FJsonValueNumber>(X.Z) }; }
UObject* Object(FJson A) { const FString P = S(A, TEXT("path")); return P.StartsWith(TEXT("/Game/")) ? LoadObject<UObject>(nullptr, *P) : nullptr; }
UBlueprint* Blueprint(FJson A) { const FString P = S(A, TEXT("blueprint")); return P.StartsWith(TEXT("/Game/")) ? LoadObject<UBlueprint>(nullptr, *P) : nullptr; }
UWidget* Widget(FJson A)
{
    auto BP = Cast<UWidgetBlueprint>(Blueprint(A));
    return BP && BP->WidgetTree ? BP->WidgetTree->FindWidget(FName(*S(A, TEXT("widget")))) : nullptr;
}
UEdGraph* Graph(UBlueprint* BP, const FString& Name)
{
    TArray<UEdGraph*> Graphs; BP->GetAllGraphs(Graphs);
    for (auto G : Graphs) if (G->GetName() == Name) return G;
    return nullptr;
}
UEdGraphNode* Node(UEdGraph* G, const FString& Id)
{
    if (!G) return nullptr;
    for (auto X : G->Nodes) if (X && X->NodeGuid.ToString(EGuidFormats::DigitsWithHyphens) == Id) return X;
    return nullptr;
}
FJson NodeInfo(UEdGraphNode* Node)
{
    auto J = Path(Node); J->SetStringField(TEXT("id"), Node->NodeGuid.ToString(EGuidFormats::DigitsWithHyphens));
    J->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::FullTitle).ToString());
    TArray<TSharedPtr<FJsonValue>> Pins;
    for (auto Pin : Node->Pins) if (Pin && !Pin->bHidden) {
        auto P = Obj(); P->SetStringField(TEXT("name"), Pin->PinName.ToString());
        P->SetStringField(TEXT("direction"), Pin->Direction == EGPD_Input ? TEXT("input") : TEXT("output"));
        P->SetStringField(TEXT("type"), Pin->PinType.PinCategory.ToString()); P->SetStringField(TEXT("default"), Pin->DefaultValue);
        TArray<TSharedPtr<FJsonValue>> Links;
        for (auto Link : Pin->LinkedTo) { auto L = Obj(); L->SetStringField(TEXT("node"), Link->GetOwningNode()->NodeGuid.ToString(EGuidFormats::DigitsWithHyphens)); L->SetStringField(TEXT("pin"), Link->PinName.ToString()); Links.Add(JV(L)); }
        P->SetArrayField(TEXT("links"), Links); Pins.Add(JV(P));
    }
    J->SetArrayField(TEXT("pins"), Pins); return J;
}
FReply Compile(UBlueprint* BP)
{
    FCompilerResultsLog Log; FKismetEditorUtilities::CompileBlueprint(BP, EBlueprintCompileOptions::None, &Log);
    auto R = Path(BP); R->SetNumberField(TEXT("errors"), Log.NumErrors); R->SetNumberField(TEXT("warnings"), Log.NumWarnings);
    TArray<TSharedPtr<FJsonValue>> Messages;
    for (auto Message : Log.Messages) Messages.Add(MakeShared<FJsonValueString>(Message->ToText().ToString()));
    R->SetArrayField(TEXT("messages"), Messages); R->SetBoolField(TEXT("compiled"), Log.NumErrors == 0);
    return Good(R); // Compiler diagnostics are data, never silently discarded.
}
#define QC_REQUIRE(Condition, Message) if (!(Condition)) return Fail(TEXT(Message))

bool IsNewGamePackage(const FString& Package)
{
    return Package.StartsWith(TEXT("/Game/")) && FPackageName::IsValidLongPackageName(Package)
        && !FindPackage(nullptr, *Package) && !FPackageName::DoesPackageExist(Package)
        && !FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get().GetAssetByObjectPath(
            FSoftObjectPath(Package + TEXT(".") + FPackageName::GetLongPackageAssetName(Package))).IsValid();
}

FReply ImportAsset(FJson A)
{
    const FString Package = S(A, TEXT("path"));
    QC_REQUIRE(IsNewGamePackage(Package), "Use a new valid /Game package path without the object suffix");
    const FString Relative = S(A, TEXT("source"));
    QC_REQUIRE(!Relative.IsEmpty() && FPaths::IsRelative(Relative), "Use a source path relative to the project");
    const FString ProjectDir = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
    const FString Source = FPaths::ConvertRelativePathToFull(ProjectDir, Relative);
    QC_REQUIRE(FPaths::IsUnderDirectory(Source, ProjectDir) && IFileManager::Get().FileExists(*Source), "Source file must exist inside the project");
    const FString Ext = FPaths::GetExtension(Source).ToLower();
    const bool IsMesh = Ext == TEXT("fbx");
    QC_REQUIRE(IsMesh || Ext == TEXT("png") || Ext == TEXT("tga") || Ext == TEXT("jpg") || Ext == TEXT("jpeg"), "Use static mesh FBX or a PNG/TGA/JPEG texture");
    const FString TextureType = S(A, TEXT("texture_type"), TEXT("color"));
    QC_REQUIRE(TextureType == TEXT("color") || TextureType == TEXT("linear") || TextureType == TEXT("normal"), "texture_type must be color, linear or normal");

    auto Task = NewObject<UAssetImportTask>();
    Task->Filename = Source;
    Task->DestinationPath = FPackageName::GetLongPackagePath(Package);
    Task->DestinationName = FPackageName::GetLongPackageAssetName(Package);
    Task->bAutomated = true;
    Task->bAsync = false;
    Task->bSave = false;
    Task->bReplaceExisting = false;
    Task->bReplaceExistingSettings = false;
    if (IsMesh) {
        auto Factory = NewObject<UFbxFactory>(Task);
        auto Options = Factory->ImportUI.Get();
        Factory->SetDetectImportTypeOnImport(false);
        Options->bAutomatedImportShouldDetectType = false;
        Options->MeshTypeToImport = FBXIT_StaticMesh;
        Options->OriginalImportType = FBXIT_StaticMesh;
        Options->bImportAsSkeletal = false;
        Options->bImportMesh = true;
        Options->bImportAnimations = false;
        Options->bImportMaterials = false;
        Options->bImportTextures = false;
        Options->StaticMeshImportData->bCombineMeshes = true;
        Task->Factory = Factory;
        Task->Options = Options;
    } else {
        Task->Factory = NewObject<UTextureFactory>(Task);
    }
    FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get().ImportAssetTasks({Task});
    const auto& Objects = Task->GetObjects();
    QC_REQUIRE(Objects.Num() == 1 && Objects[0] && Objects[0]->GetOutermost()->GetName() == Package,
        "Import did not produce the requested asset; inspect the content directory before retrying");
    auto R = Path(Objects[0]);
    if (IsMesh) {
        auto Mesh = Cast<UStaticMesh>(Objects[0]);
        QC_REQUIRE(Mesh, "Import did not produce a static mesh");
        TArray<TSharedPtr<FJsonValue>> Slots;
        for (const auto& Slot : Mesh->GetStaticMaterials()) Slots.Add(MakeShared<FJsonValueString>(Slot.MaterialSlotName.ToString()));
        R->SetArrayField(TEXT("material_slots"), Slots);
        R->SetArrayField(TEXT("size_cm"), Vec(Mesh->GetBoundingBox().GetSize()));
    } else {
        auto Texture = Cast<UTexture2D>(Objects[0]);
        QC_REQUIRE(Texture, "Import did not produce a 2D texture");
        Texture->SRGB = TextureType == TEXT("color");
        Texture->CompressionSettings = TextureType == TEXT("normal") ? TC_Normalmap : (Texture->SRGB ? TC_Default : TC_Masks);
        Texture->PostEditChange();
        Texture->MarkPackageDirty();
        const auto Size = Texture->GetImportedSize();
        R->SetNumberField(TEXT("width"), Size.X);
        R->SetNumberField(TEXT("height"), Size.Y);
        R->SetStringField(TEXT("texture_type"), TextureType);
    }
    return Good(R);
}

FReply CreateMaterial(FJson A)
{
    const FString Package = S(A, TEXT("path"));
    QC_REQUIRE(IsNewGamePackage(Package), "Use a new valid /Game package path without the object suffix");
    struct FMap { const TCHAR* Field; EMaterialProperty Property; bool Scalar; };
    const FMap Maps[] = {
        { TEXT("base_color"), MP_BaseColor, false }, { TEXT("normal"), MP_Normal, false },
        { TEXT("roughness"), MP_Roughness, true }, { TEXT("metallic"), MP_Metallic, true },
        { TEXT("ambient_occlusion"), MP_AmbientOcclusion, true }
    };
    TArray<TPair<FMap, UTexture2D*>> Textures;
    for (const auto& Map : Maps) {
        if (!A->HasField(Map.Field)) continue;
        const FString TexturePath = S(A, Map.Field);
        auto Texture = TexturePath.StartsWith(TEXT("/Game/")) ? LoadObject<UTexture2D>(nullptr, *TexturePath) : nullptr;
        QC_REQUIRE(Texture, "Material inputs must reference existing /Game Texture2D object paths");
        Textures.Emplace(Map, Texture);
    }
    QC_REQUIRE(!Textures.IsEmpty(), "Provide at least one texture map");
    auto& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    auto Material = Cast<UMaterial>(Tools.CreateAsset(FPackageName::GetLongPackageAssetName(Package),
        FPackageName::GetLongPackagePath(Package), UMaterial::StaticClass(), NewObject<UMaterialFactoryNew>()));
    QC_REQUIRE(Material, "Material creation failed");
    int Y = 0;
    for (const auto& [Map, Texture] : Textures) {
        auto Sample = Cast<UMaterialExpressionTextureSample>(UMaterialEditingLibrary::CreateMaterialExpression(
            Material, UMaterialExpressionTextureSample::StaticClass(), -400, Y));
        QC_REQUIRE(Sample, "Could not create a material sample; inspect material before retrying");
        Sample->Texture = Texture;
        Sample->AutoSetSampleType();
        QC_REQUIRE(UMaterialEditingLibrary::ConnectMaterialProperty(Sample, Map.Scalar ? TEXT("R") : TEXT("RGB"), Map.Property),
            "Could not connect texture; inspect material before retrying");
        Y += 260;
    }
    UMaterialEditingLibrary::RecompileMaterial(Material);
    Material->MarkPackageDirty();
    auto R = Path(Material);
    R->SetNumberField(TEXT("connected_maps"), Textures.Num());
    return Good(R);
}

FReply InspectScene(UWorld* World)
{
    TArray<TSharedPtr<FJsonValue>> Cameras, Lights, PostProcess, Characters;
    const auto Transform = [](const USceneComponent* Component) {
        auto R = Path(const_cast<USceneComponent*>(Component));
        R->SetStringField(TEXT("actor"), Component->GetOwner()->GetPathName());
        R->SetArrayField(TEXT("location_cm"), Vec(Component->GetComponentLocation()));
        const auto Rot = Component->GetComponentRotation();
        R->SetArrayField(TEXT("rotation"), Vec(FVector(Rot.Pitch, Rot.Yaw, Rot.Roll)));
        R->SetBoolField(TEXT("visible"), Component->IsVisible() && !Component->GetOwner()->IsHidden());
        return R;
    };
    for (auto Actor : GEditor->GetEditorSubsystem<UEditorActorSubsystem>()->GetAllLevelActors()) {
        TInlineComponentArray<UCameraComponent*> CameraComponents(Actor);
        for (auto Camera : CameraComponents) {
            if (Cameras.Num() >= 48) break;
            auto R = Transform(Camera);
            R->SetNumberField(TEXT("fov_deg"), Camera->FieldOfView);
            R->SetNumberField(TEXT("aspect_ratio"), Camera->AspectRatio);
            R->SetBoolField(TEXT("orthographic"), Camera->ProjectionMode == ECameraProjectionMode::Orthographic);
            R->SetNumberField(TEXT("post_process_weight"), Camera->PostProcessBlendWeight);
            Cameras.Add(JV(R));
        }
        TInlineComponentArray<ULightComponentBase*> LightComponents(Actor);
        for (auto Light : LightComponents) {
            if (Lights.Num() >= 96) break;
            auto R = Transform(Light);
            const auto Color = Light->GetLightColor();
            R->SetArrayField(TEXT("linear_rgb"), Vec(FVector(Color.R, Color.G, Color.B)));
            R->SetNumberField(TEXT("intensity"), Light->Intensity);
            R->SetBoolField(TEXT("casts_shadows"), Light->CastShadows);
            if (auto Direct = Cast<ULightComponent>(Light)) {
                if (Direct->bUseTemperature) R->SetNumberField(TEXT("temperature_kelvin"), Direct->Temperature);
            }
            if (auto Local = Cast<ULocalLightComponent>(Light)) {
                R->SetNumberField(TEXT("radius_cm"), Local->AttenuationRadius);
                R->SetNumberField(TEXT("intensity_units"), int32(Local->GetLightUnits()));
            }
            Lights.Add(JV(R));
        }
        if (auto Volume = Cast<APostProcessVolume>(Actor); Volume && PostProcess.Num() < 40) {
            auto R = Path(Volume);
            R->SetBoolField(TEXT("enabled"), Volume->bEnabled);
            R->SetBoolField(TEXT("unbound"), Volume->bUnbound);
            R->SetNumberField(TEXT("priority"), Volume->Priority);
            R->SetNumberField(TEXT("weight"), Volume->BlendWeight);
            if (Volume->Settings.bOverride_AutoExposureBias) R->SetNumberField(TEXT("exposure_bias"), Volume->Settings.AutoExposureBias);
            PostProcess.Add(JV(R));
        }
        TInlineComponentArray<USkeletalMeshComponent*> SkeletalComponents(Actor);
        for (auto Component : SkeletalComponents) {
            if (Characters.Num() >= 48) break;
            auto R = Transform(Component);
            if (auto Mesh = Component->GetSkeletalMeshAsset()) {
                R->SetStringField(TEXT("mesh"), Mesh->GetPathName());
                if (auto Skeleton = Mesh->GetSkeleton()) R->SetStringField(TEXT("skeleton"), Skeleton->GetPathName());
            }
            if (auto Anim = Component->AnimationData.AnimToPlay.Get()) R->SetStringField(TEXT("animation"), Anim->GetPathName());
            if (auto Class = Component->GetAnimClass()) R->SetStringField(TEXT("anim_blueprint_class"), Class->GetPathName());
            Characters.Add(JV(R));
        }
    }
    auto R = Obj();
    R->SetStringField(TEXT("level"), World->GetOutermost()->GetName());
    R->SetArrayField(TEXT("cameras"), Cameras);
    R->SetArrayField(TEXT("lights"), Lights);
    R->SetArrayField(TEXT("post_process"), PostProcess);
    R->SetArrayField(TEXT("skeletal_components"), Characters);
    return Good(R);
}

FReply CaptureViewport(UWorld* World)
{
    QC_REQUIRE(GDynamicRHI && FString(GDynamicRHI->GetName()) != TEXT("Null"), "Viewport capture needs a rendered editor (launch without NullRHI)");
    auto Client = GCurrentLevelEditingViewportClient;
    QC_REQUIRE(Client && Client->GetWorld() == World && Client->Viewport &&
        Client->IsPerspective(), "Activate a perspective level viewport");
    auto Viewport = Client->Viewport;
    const auto Size = Viewport->GetSizeXY();
    QC_REQUIRE(Size.X > 0 && Size.Y > 0 && int64(Size.X) * Size.Y <= 16777216, "Viewport size exceeds 16 megapixels or is empty");
    TArray<FColor> Pixels;
    QC_REQUIRE(GetViewportScreenShot(Viewport, Pixels) && Pixels.Num() == Size.X * Size.Y, "Could not read the rendered level viewport");
    const FString Folder = FPaths::ProjectSavedDir() / TEXT("QCoderI/Previews");
    QC_REQUIRE(IFileManager::Get().MakeDirectory(*Folder, true), "Could not create preview directory");
    const FString Name = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens) + TEXT(".png");
    TArray64<uint8> PNG;
    FImageUtils::PNGCompressImageArray(Size.X, Size.Y, Pixels, PNG);
    QC_REQUIRE(!PNG.IsEmpty() && FFileHelper::SaveArrayToFile(PNG, *(Folder / Name)), "Could not save viewport PNG");
    auto R = Obj();
    R->SetStringField(TEXT("file"), Name);
    R->SetNumberField(TEXT("width"), Size.X);
    R->SetNumberField(TEXT("height"), Size.Y);
    R->SetNumberField(TEXT("view_mode"), Client->GetViewMode());
    R->SetArrayField(TEXT("location_cm"), Vec(Client->GetViewLocation()));
    const auto Rot = Client->GetViewRotation();
    R->SetArrayField(TEXT("rotation"), Vec(FVector(Rot.Pitch, Rot.Yaw, Rot.Roll)));
    return Good(R);
}

FReply Dispatch(const FString& Action, FJson A)
{
    if (Action == TEXT("describe")) {
        const TCHAR* Docs = TEXT(R"JSON({
"scene_list":"{} -> actors in current editor world with path, label, location, rotation (pitch,yaw,roll), scale",
"scene_inspect":"{} -> camera and light settings, exposure volumes and skeletal components in the current level. Use unreal_viewport for the actual image.",
"viewport_capture":"{} -> PNG from active perspective editor viewport, current camera transform and view mode. Requires real rendering.",
"animation_inspect":"{path:'/Game/...'} -> animation sequence skeleton, duration, sample rate and key count.",
"actor_spawn":"{class:'/Script/Engine.StaticMeshActor' or '/Game/...BP_C',label:'Floor',location:[x,y,z],rotation:[pitch,yaw,roll],scale:[x,y,z],mesh:'/Engine/BasicShapes/Cube.Cube' optional}. Units cm. No overwriting.",
"actor_transform":"{path:actor path,location:[x,y,z] optional,rotation:[pitch,yaw,roll] optional,scale:[x,y,z] optional}",
"actor_delete":"{path:actor path}. Undo supported.",
"asset_list":"{directory:'/Game',limit:100}. Recursive; max 500. Includes Font and FontFace assets.",
"asset_import":"{source:'relative/file.fbx|png|tga|jpg|jpeg',path:'/Game/Folder/NewAsset',texture_type:'color|linear|normal' optional}. Imports one new static mesh (FBX) or texture. For normal maps use Unreal/DirectX convention. Save explicitly.",
"material_create":"{path:'/Game/Folder/M_New',base_color:'/Game/...T_Color.T_Color',normal,roughness,metallic,ambient_occlusion}. Supply at least one texture object path. Scalar inputs read the red channel. Creates an editable material; save explicitly.",
"mesh_set_material":"{path:'/Game/Folder/SM_Mesh.SM_Mesh',slot:0,material:'/Game/Folder/M_New.M_New'}. Assign an existing material to an existing static mesh slot. Save the mesh explicitly.",
"object_inspect":"{path:'/Game/...'} -> editable reflected properties in Unreal text format. Also inspect component paths.",
"object_set":"{path:'/Game/...',property:'PropertyName',value:'Unreal text format'}. Only editable, non-transient properties. Inspect first.",
"blueprint_create":"{path:'/Game/Blueprints/BP_Door',parent_class:'/Script/Engine.Actor' optional}. Never overwrite.",
"blueprint_inspect":"{blueprint:'/Game/...'} -> graphs, node GUIDs, pins, links, member variables",
"blueprint_variable":"{blueprint:'/Game/...',name:'Counter',type:'bool|int|float|string|name|text',default:'0' optional}. Compile after adding.",
"blueprint_node":"{blueprint:'/Game/...',graph:'EventGraph' optional,kind:'event|call|get|set|bound_event',name:'ReceiveBeginPlay|FunctionName|VariableName|OnClicked',class:'/Script/Engine.KismetSystemLibrary' for call or parent event,widget:'PlayButton' for bound_event,x:0,y:0}. Returns actual node id and pins. For widget variables compile widget tree BEFORE bound_event. Events cannot be duplicated.",
"blueprint_connect":"{blueprint:'/Game/...',graph:'EventGraph' optional,from_node:GUID,from_pin:'then',to_node:GUID,to_pin:'execute'}. Refuses links that would replace existing connections; compiler checks types.",
"blueprint_pin":"{blueprint:'/Game/...',graph:'EventGraph' optional,node:GUID,pin:'InString',value:'Hello'}. Use object_path instead of value for object pins. Defaults apply only to unlinked input pins.",
"blueprint_compile":"{blueprint:'/Game/...'} -> compiled flag, compiler errors/warnings/messages. Must check compiled=true.",
"widget_create":"{path:'/Game/UI/WBP_MainMenu'} -> Widget Blueprint with CanvasPanel Root. Never overwrite.",
"widget_add":"{blueprint:'/Game/UI/WBP_MainMenu',parent:'Root',name:'Title',class:'/Script/UMG.TextBlock'}. Root/parent must exist; all widgets exposed as Blueprint variables. Supports native UMG widgets.",
"widget_tree":"{blueprint:'/Game/UI/WBP_MainMenu'} -> names, paths, parents, classes, text/font for TextBlock. Blueprint remains editable in Designer.",
"widget_text":"{blueprint:'/Game/...',widget:'Title',text:'Main menu'}",
"widget_font":"{blueprint:'/Game/...',widget:'Title',size:48 optional,font:'/Game/Fonts/MyFont.MyFont' optional,typeface:'Regular' optional}. TextBlock only. Font or FontFace asset, not a Windows filename. Import font with UE first; asset_list finds imported fonts.",
"widget_layout":"{blueprint:'/Game/...',widget:'Title',position:[100,80,0],size:[500,100,0]}. CanvasPanelSlot only, coordinates relative to default top-left anchor.",
"asset_save":"{path:'/Game/...'} -> save ONLY this loaded asset. Blueprint compilation must succeed first.",
"level_save":"{} saves current named level. {path:'/Game/Maps/MyScene'} saves current world as a NEW map (no overwriting other maps). Does not save all project assets."
})JSON");
        FJson R; FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(FString(Docs)), R); return Good(R);
    }
    QC_REQUIRE(GEditor && GEditor->GetEditorWorldContext().World(), "Editor world is not ready");
    QC_REQUIRE(!GEditor->PlayWorld, "Stop Play In Editor before using the bridge");
    auto World = GEditor->GetEditorWorldContext().World();
    auto Actors = GEditor->GetEditorSubsystem<UEditorActorSubsystem>();
    auto Assets = GEditor->GetEditorSubsystem<UEditorAssetSubsystem>();
    if (Action == TEXT("scene_inspect")) return InspectScene(World);
    if (Action == TEXT("viewport_capture")) return CaptureViewport(World);
    if (Action == TEXT("animation_inspect")) {
        auto Anim = Cast<UAnimSequenceBase>(Object(A));
        QC_REQUIRE(Anim, "Use the object path of an animation sequence");
        auto R = Path(Anim);
        if (auto Skeleton = Anim->GetSkeleton()) R->SetStringField(TEXT("skeleton"), Skeleton->GetPathName());
        R->SetNumberField(TEXT("seconds"), Anim->GetPlayLength());
        R->SetNumberField(TEXT("sample_rate"), Anim->GetSamplingFrameRate().AsDecimal());
        R->SetNumberField(TEXT("sampled_keys"), Anim->GetNumberOfSampledKeys());
        return Good(R);
    }
    if (Action == TEXT("scene_list")) {
        auto R = Obj(); TArray<TSharedPtr<FJsonValue>> Items;
        for (auto Actor : Actors->GetAllLevelActors()) { auto J = Path(Actor); J->SetStringField(TEXT("label"), Actor->GetActorLabel()); J->SetArrayField(TEXT("location"), Vec(Actor->GetActorLocation())); const auto Rot = Actor->GetActorRotation(); J->SetArrayField(TEXT("rotation"), Vec(FVector(Rot.Pitch, Rot.Yaw, Rot.Roll))); J->SetArrayField(TEXT("scale"), Vec(Actor->GetActorScale3D())); Items.Add(JV(J)); }
        R->SetStringField(TEXT("level"), World->GetOutermost()->GetName()); R->SetArrayField(TEXT("actors"), Items); return Good(R);
    }
    if (Action == TEXT("asset_list")) {
        const FString Directory = S(A, TEXT("directory"), TEXT("/Game")); QC_REQUIRE(Directory == TEXT("/Game") || Directory.StartsWith(TEXT("/Game/")), "Use /Game content directory");
        TArray<FAssetData> Data; FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get().GetAssetsByPath(FName(*Directory), Data, true);
        const int Limit = FMath::Clamp(int(N(A, TEXT("limit"), 100)), 1, 500); TArray<TSharedPtr<FJsonValue>> Items;
        for (const auto& Asset : Data) { if (Items.Num() >= Limit) break; auto J = Obj(); J->SetStringField(TEXT("path"), Asset.GetSoftObjectPath().ToString()); J->SetStringField(TEXT("class"), Asset.AssetClassPath.ToString()); Items.Add(JV(J)); }
        auto R = Obj(); R->SetArrayField(TEXT("assets"), Items); R->SetBoolField(TEXT("truncated"), Data.Num() > Limit); return Good(R);
    }
    if (Action == TEXT("asset_import")) return ImportAsset(A);
    if (Action == TEXT("material_create")) return CreateMaterial(A);
    if (Action == TEXT("mesh_set_material")) {
        auto Mesh = Cast<UStaticMesh>(Object(A));
        const FString MaterialPath = S(A, TEXT("material"));
        auto Material = LoadObject<UMaterialInterface>(nullptr, *MaterialPath);
        const double Slot = N(A, TEXT("slot"), -1);
        QC_REQUIRE(Mesh && Material && FMath::IsFinite(Slot) && Slot >= 0 && Slot < Mesh->GetStaticMaterials().Num()
            && Slot == int32(Slot), "Use a valid static mesh, material object path and existing integer slot");
        FScopedTransaction Tx(NSLOCTEXT("QCoderI", "MeshMaterial", "QCoderI: assign mesh material"));
        Mesh->Modify();
        Mesh->SetMaterial(int32(Slot), Material);
        Mesh->PostEditChange();
        Mesh->MarkPackageDirty();
        auto R = Path(Mesh);
        R->SetNumberField(TEXT("slot"), Slot);
        R->SetStringField(TEXT("material"), Mesh->GetMaterial(int32(Slot))->GetPathName());
        return Good(R);
    }
    if (Action == TEXT("actor_spawn")) {
        const FString ClassPath = S(A, TEXT("class")); QC_REQUIRE(ClassPath.StartsWith(TEXT("/Script/")) || ClassPath.StartsWith(TEXT("/Game/")), "Use a full actor class path");
        auto Class = LoadObject<UClass>(nullptr, *ClassPath); QC_REQUIRE(Class && Class->IsChildOf(AActor::StaticClass()) && !Class->HasAnyClassFlags(CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists), "Invalid actor class");
        UStaticMesh* Mesh = nullptr;
        if (A->HasField(TEXT("mesh"))) { Mesh = LoadObject<UStaticMesh>(nullptr, *S(A, TEXT("mesh"))); QC_REQUIRE(Mesh && Class->IsChildOf(AStaticMeshActor::StaticClass()), "Mesh requires StaticMeshActor and a valid mesh asset"); }
        FScopedTransaction Tx(NSLOCTEXT("QCoderI", "Spawn", "QCoderI: spawn actor")); const auto Rotation = V(A, TEXT("rotation"));
        // EditorActorSubsystem placement goes through the active viewport's
        // snapping grid, which is unavailable in headless/offscreen editors.
        // World spawning still broadcasts editor actor-added notifications.
        World->GetCurrentLevel()->Modify();
        FActorSpawnParameters Params; Params.OverrideLevel = World->GetCurrentLevel(); Params.ObjectFlags = RF_Transactional;
        Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
        auto Actor = World->SpawnActor<AActor>(Class, FTransform(FRotator(Rotation.X, Rotation.Y, Rotation.Z), V(A, TEXT("location"))), Params); QC_REQUIRE(Actor, "Actor spawn failed");
        Actor->Modify(); if (A->HasField(TEXT("label"))) Actor->SetActorLabel(S(A, TEXT("label")));
        Actor->SetActorScale3D(V(A, TEXT("scale"), FVector::OneVector));
        if (Mesh) CastChecked<AStaticMeshActor>(Actor)->GetStaticMeshComponent()->SetStaticMesh(Mesh);
        return Good(Path(Actor));
    }
    if (Action == TEXT("actor_transform") || Action == TEXT("actor_delete")) {
        auto Actor = Cast<AActor>(Object(A)); QC_REQUIRE(Actor && Actor->GetWorld() == World, "Actor not found in current editor world");
        FScopedTransaction Tx(NSLOCTEXT("QCoderI", "Actor", "QCoderI: edit actor")); Actor->Modify();
        if (Action == TEXT("actor_delete")) { QC_REQUIRE(Actors->DestroyActor(Actor), "Actor deletion failed"); return Good(Obj()); }
        if (A->HasField(TEXT("location"))) Actor->SetActorLocation(V(A, TEXT("location")));
        if (A->HasField(TEXT("rotation"))) { const auto Rot = V(A, TEXT("rotation")); Actor->SetActorRotation(FRotator(Rot.X, Rot.Y, Rot.Z)); }
        if (A->HasField(TEXT("scale"))) Actor->SetActorScale3D(V(A, TEXT("scale")));
        Actor->PostEditMove(true); return Good(Path(Actor));
    }
    if (Action == TEXT("object_inspect") || Action == TEXT("object_set")) {
        auto O = Object(A); QC_REQUIRE(O, "Object not found: use full /Game object path");
        if (Action == TEXT("object_inspect")) {
            auto R = Path(O), Props = Obj(); int Count = 0;
            for (TFieldIterator<FProperty> It(O->GetClass()); It && Count < 128; ++It) if (It->HasAnyPropertyFlags(CPF_Edit) && !It->HasAnyPropertyFlags(CPF_Transient)) { FString Text; It->ExportText_InContainer(0, Text, O, O, O, PPF_None); Props->SetStringField(It->GetName(), Text.Left(4096)); ++Count; }
            R->SetObjectField(TEXT("properties"), Props); return Good(R);
        }
        auto Property = FindFProperty<FProperty>(O->GetClass(), *S(A, TEXT("property")));
        QC_REQUIRE(Property && Property->HasAnyPropertyFlags(CPF_Edit) && !Property->HasAnyPropertyFlags(CPF_EditConst | CPF_Transient), "Editable property not found");
        QC_REQUIRE(A->HasTypedField<EJson::String>(TEXT("value")), "value must be an Unreal text string");
        // Parse into a temporary property buffer before mutating the object.
        void* Temp = FMemory::Malloc(Property->GetSize(), Property->GetMinAlignment()); Property->InitializeValue(Temp);
        Property->CopyCompleteValue(Temp, Property->ContainerPtrToValuePtr<void>(O));
        const bool Valid = Property->ImportText_Direct(*S(A, TEXT("value")), Temp, O, PPF_None) != nullptr;
        if (!Valid) { Property->DestroyValue(Temp); FMemory::Free(Temp); return Fail(TEXT("Invalid Unreal property text")); }
        FScopedTransaction Tx(NSLOCTEXT("QCoderI", "Property", "QCoderI: edit property")); O->Modify(); O->PreEditChange(Property);
        Property->CopyCompleteValue(Property->ContainerPtrToValuePtr<void>(O), Temp); Property->DestroyValue(Temp); FMemory::Free(Temp);
        FPropertyChangedEvent Event(Property); O->PostEditChangeProperty(Event); O->MarkPackageDirty(); return Good(Path(O));
    }
    if (Action == TEXT("blueprint_create") || Action == TEXT("widget_create")) {
        const FString P = S(A, TEXT("path"));
        QC_REQUIRE(P.StartsWith(TEXT("/Game/")) && FPackageName::IsValidLongPackageName(P) && !FPackageName::DoesPackageExist(P), "Asset path must be a new valid /Game package (no .Asset suffix)");
        auto& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get(); UBlueprint* BP = nullptr;
        if (Action == TEXT("widget_create")) {
            auto Factory = NewObject<UWidgetBlueprintFactory>(); Factory->ParentClass = UUserWidget::StaticClass();
            BP = Cast<UBlueprint>(Tools.CreateAsset(FPackageName::GetLongPackageAssetName(P), FPackageName::GetLongPackagePath(P), UWidgetBlueprint::StaticClass(), Factory));
            auto WBP = Cast<UWidgetBlueprint>(BP); QC_REQUIRE(WBP, "Widget Blueprint creation failed");
            if (!WBP->WidgetTree) WBP->WidgetTree = NewObject<UWidgetTree>(WBP, TEXT("WidgetTree"), RF_Transactional);
            // The factory may use the user's preferred root class/name. This
            // newly created asset has no user content; give the bridge a stable canvas.
            WBP->WidgetTree->RootWidget = WBP->WidgetTree->ConstructWidget<UCanvasPanel>(UCanvasPanel::StaticClass(), TEXT("Root"));
        } else {
            auto Parent = LoadObject<UClass>(nullptr, *S(A, TEXT("parent_class"), TEXT("/Script/Engine.Actor")));
            QC_REQUIRE(Parent && FKismetEditorUtilities::CanCreateBlueprintOfClass(Parent) && !Parent->IsChildOf(UUserWidget::StaticClass()), "Invalid parent; use widget_create for UUserWidget");
            auto Factory = NewObject<UBlueprintFactory>(); Factory->ParentClass = Parent;
            BP = Cast<UBlueprint>(Tools.CreateAsset(FPackageName::GetLongPackageAssetName(P), FPackageName::GetLongPackagePath(P), UBlueprint::StaticClass(), Factory));
        }
        QC_REQUIRE(BP, "Blueprint creation failed"); FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP); return Good(Path(BP));
    }
    if (Action == TEXT("widget_add") || Action == TEXT("widget_tree") || Action == TEXT("widget_text") || Action == TEXT("widget_font") || Action == TEXT("widget_layout")) {
        auto BP = Cast<UWidgetBlueprint>(Blueprint(A)); QC_REQUIRE(BP && BP->WidgetTree, "Widget Blueprint not found");
        auto Tree = BP->WidgetTree;
        if (Action == TEXT("widget_tree")) {
            TArray<UWidget*> Widgets; Tree->GetAllWidgets(Widgets); TArray<TSharedPtr<FJsonValue>> Items;
            for (auto W : Widgets) { auto J = Path(W); J->SetStringField(TEXT("name"), W->GetName()); J->SetStringField(TEXT("parent"), W->GetParent() ? W->GetParent()->GetName() : TEXT(""));
                if (auto Text = Cast<UTextBlock>(W)) { J->SetStringField(TEXT("text"), Text->GetText().ToString()); const auto Font = Text->GetFont(); J->SetNumberField(TEXT("font_size"), Font.Size); J->SetStringField(TEXT("font"), Font.FontObject ? Font.FontObject->GetPathName() : TEXT("")); }
                Items.Add(JV(J)); }
            auto R = Path(BP); R->SetArrayField(TEXT("widgets"), Items); return Good(R);
        }
        if (Action == TEXT("widget_add")) {
            const FString Name = S(A, TEXT("name")), ClassPath = S(A, TEXT("class"));
            QC_REQUIRE(!Name.IsEmpty() && FName::IsValidXName(Name, INVALID_OBJECTNAME_CHARACTERS) && !Tree->FindWidget(FName(*Name)) && !FindObject<UObject>(Tree, *Name), "Widget name invalid or already exists");
            auto Parent = Cast<UPanelWidget>(Tree->FindWidget(FName(*S(A, TEXT("parent"), TEXT("Root")))));
            QC_REQUIRE(Parent && !(Cast<UContentWidget>(Parent) && Parent->GetChildrenCount() > 0), "Parent missing, not a panel, or single-child widget already occupied");
            QC_REQUIRE(ClassPath.StartsWith(TEXT("/Script/UMG.")), "Use a native /Script/UMG widget class");
            auto Class = LoadObject<UClass>(nullptr, *ClassPath); QC_REQUIRE(Class && Class->IsChildOf(UWidget::StaticClass()) && !Class->HasAnyClassFlags(CLASS_Abstract | CLASS_Deprecated), "Invalid widget class");
            FScopedTransaction Tx(NSLOCTEXT("QCoderI", "AddWidget", "QCoderI: add UMG widget")); BP->Modify(); Tree->Modify(); Parent->Modify();
            auto W = Tree->ConstructWidget<UWidget>(Class, FName(*Name)); QC_REQUIRE(W, "Widget creation failed"); W->bIsVariable = true;
            QC_REQUIRE(Parent->AddChild(W), "Widget attachment failed"); FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP); return Good(Path(W));
        }
        auto W = Widget(A); QC_REQUIRE(W, "Widget not found");
        auto Text = Cast<UTextBlock>(W);
        if (Action == TEXT("widget_text")) {
            QC_REQUIRE(Text && A->HasTypedField<EJson::String>(TEXT("text")), "TextBlock and text required");
            FScopedTransaction Tx(NSLOCTEXT("QCoderI", "Text", "QCoderI: edit UMG text")); BP->Modify(); Text->Modify(); Text->SetText(FText::FromString(S(A, TEXT("text"))));
        } else if (Action == TEXT("widget_font")) {
            QC_REQUIRE(Text, "Font command requires a TextBlock"); auto Font = Text->GetFont();
            if (A->HasField(TEXT("font"))) { auto FontObject = LoadObject<UObject>(nullptr, *S(A, TEXT("font"))); QC_REQUIRE(FontObject && (FontObject->IsA<UFont>() || FontObject->IsA<UFontFace>()), "Import a Font/FontFace asset in UE first"); Font.FontObject = FontObject; }
            const auto Size = N(A, TEXT("size"), Font.Size); QC_REQUIRE(Size >= 1 && Size <= 1000, "Font size must be 1..1000"); Font.Size = Size;
            if (A->HasField(TEXT("typeface"))) Font.TypefaceFontName = FName(*S(A, TEXT("typeface")));
            FScopedTransaction Tx(NSLOCTEXT("QCoderI", "Font", "QCoderI: edit UMG font")); BP->Modify(); Text->Modify(); Text->SetFont(Font);
        } else {
            auto Slot = Cast<UCanvasPanelSlot>(W->Slot); QC_REQUIRE(Slot, "widget_layout requires a child of CanvasPanel");
            FScopedTransaction Tx(NSLOCTEXT("QCoderI", "Layout", "QCoderI: edit UMG layout")); BP->Modify(); W->Modify(); Slot->Modify();
            if (A->HasField(TEXT("position"))) { const auto P = V(A, TEXT("position")); Slot->SetPosition(FVector2D(P.X, P.Y)); }
            if (A->HasField(TEXT("size"))) { const auto P = V(A, TEXT("size")); Slot->SetSize(FVector2D(P.X, P.Y)); }
        }
        FBlueprintEditorUtils::MarkBlueprintAsModified(BP); return Good(Path(W));
    }
    if (Action.StartsWith(TEXT("blueprint_"))) {
        auto BP = Blueprint(A); QC_REQUIRE(BP, "Blueprint not found");
        if (Action == TEXT("blueprint_compile")) return Compile(BP);
        if (Action == TEXT("blueprint_inspect")) {
            auto R = Path(BP); TArray<UEdGraph*> Graphs; BP->GetAllGraphs(Graphs); TArray<TSharedPtr<FJsonValue>> Items, Variables;
            for (auto G : Graphs) { auto J = Obj(); J->SetStringField(TEXT("name"), G->GetName()); TArray<TSharedPtr<FJsonValue>> Nodes; for (auto X : G->Nodes) if (X) Nodes.Add(JV(NodeInfo(X))); J->SetArrayField(TEXT("nodes"), Nodes); Items.Add(JV(J)); }
            for (const auto& Variable : BP->NewVariables) { auto J = Obj(); J->SetStringField(TEXT("name"), Variable.VarName.ToString()); J->SetStringField(TEXT("type"), Variable.VarType.PinCategory.ToString()); Variables.Add(JV(J)); }
            R->SetArrayField(TEXT("graphs"), Items); R->SetArrayField(TEXT("variables"), Variables); return Good(R);
        }
        if (Action == TEXT("blueprint_variable")) {
            const FString Name = S(A, TEXT("name")), Type = S(A, TEXT("type"));
            QC_REQUIRE(!Name.IsEmpty() && FName::IsValidXName(Name, INVALID_OBJECTNAME_CHARACTERS), "Invalid variable name");
            QC_REQUIRE(!BP->SkeletonGeneratedClass || !FindFProperty<FProperty>(BP->SkeletonGeneratedClass, *Name), "Variable already exists");
            for (const auto& Variable : BP->NewVariables) QC_REQUIRE(Variable.VarName.ToString() != Name, "Variable already exists");
            FEdGraphPinType Pin;
            if (Type == TEXT("float")) { Pin.PinCategory = UEdGraphSchema_K2::PC_Real; Pin.PinSubCategory = UEdGraphSchema_K2::PC_Double; }
            else { QC_REQUIRE(Type == TEXT("bool") || Type == TEXT("int") || Type == TEXT("string") || Type == TEXT("name") || Type == TEXT("text"), "Unsupported variable type"); Pin.PinCategory = FName(*Type); }
            FScopedTransaction Tx(NSLOCTEXT("QCoderI", "Variable", "QCoderI: add Blueprint variable")); BP->Modify();
            QC_REQUIRE(FBlueprintEditorUtils::AddMemberVariable(BP, FName(*Name), Pin, S(A, TEXT("default"))), "Variable creation failed"); return Good(Path(BP));
        }
        auto G = Graph(BP, S(A, TEXT("graph"), TEXT("EventGraph"))); QC_REQUIRE(G, "Graph not found; inspect Blueprint first");
        const auto Schema = Cast<UEdGraphSchema_K2>(G->GetSchema()); QC_REQUIRE(Schema, "Only K2 graphs supported");
        if (Action == TEXT("blueprint_node")) {
            const FString Kind = S(A, TEXT("kind")), Name = S(A, TEXT("name")); QC_REQUIRE(!Name.IsEmpty(), "Node name required");
            UClass* Owner = nullptr; UFunction* Function = nullptr; FObjectProperty* ComponentProperty = nullptr; FMulticastDelegateProperty* Delegate = nullptr;
            if (Kind == TEXT("call") || Kind == TEXT("event")) {
                const FString ClassPath = S(A, TEXT("class")); Owner = ClassPath.IsEmpty() && Kind == TEXT("event") ? BP->ParentClass.Get() : LoadObject<UClass>(nullptr, *ClassPath);
                Function = Owner ? Owner->FindFunctionByName(FName(*Name)) : nullptr;
                QC_REQUIRE(Function && Function->HasAnyFunctionFlags(FUNC_BlueprintCallable | FUNC_BlueprintEvent), "Function not found or not exposed to Blueprint");
                if (Kind == TEXT("event")) {
                    QC_REQUIRE(BP->ParentClass->IsChildOf(Owner) && Function->HasAnyFunctionFlags(FUNC_BlueprintEvent), "Event must be an overridable parent event");
                    for (auto X : G->Nodes) if (auto E = Cast<UK2Node_Event>(X)) QC_REQUIRE(E->EventReference.GetMemberName() != FName(*Name), "Event already exists; reuse its node");
                }
            } else if (Kind == TEXT("get") || Kind == TEXT("set")) {
                QC_REQUIRE(BP->SkeletonGeneratedClass && FindFProperty<FProperty>(BP->SkeletonGeneratedClass, *Name), "Compile Blueprint first; variable not found");
            } else if (Kind == TEXT("bound_event")) {
                const auto WidgetName = FName(*S(A, TEXT("widget")));
                ComponentProperty = BP->GeneratedClass ? FindFProperty<FObjectProperty>(BP->GeneratedClass, WidgetName) : nullptr;
                Delegate = ComponentProperty ? FindFProperty<FMulticastDelegateProperty>(ComponentProperty->PropertyClass, *Name) : nullptr;
                QC_REQUIRE(ComponentProperty && Delegate, "Compile widget tree first; widget variable/delegate not found");
                for (auto X : G->Nodes) if (auto E = Cast<UK2Node_ComponentBoundEvent>(X)) QC_REQUIRE(E->ComponentPropertyName != WidgetName || E->DelegatePropertyName != FName(*Name), "Bound event already exists");
            } else return Fail(TEXT("Unknown node kind"));
            FScopedTransaction Tx(NSLOCTEXT("QCoderI", "Node", "QCoderI: add Blueprint node")); BP->Modify(); G->Modify(); UK2Node* X = nullptr;
            if (Kind == TEXT("call")) { auto Call = NewObject<UK2Node_CallFunction>(G); Call->SetFromFunction(Function); X = Call; }
            else if (Kind == TEXT("event")) { auto Event = NewObject<UK2Node_Event>(G); Event->EventReference.SetExternalMember(FName(*Name), Owner); Event->bOverrideFunction = true; X = Event; }
            else if (Kind == TEXT("get")) { auto Get = NewObject<UK2Node_VariableGet>(G); Get->VariableReference.SetSelfMember(FName(*Name)); X = Get; }
            else if (Kind == TEXT("set")) { auto Set = NewObject<UK2Node_VariableSet>(G); Set->VariableReference.SetSelfMember(FName(*Name)); X = Set; }
            else { auto Event = NewObject<UK2Node_ComponentBoundEvent>(G); Event->InitializeComponentBoundEventParams(ComponentProperty, Delegate); X = Event; }
            X->SetFlags(RF_Transactional); G->AddNode(X, false, false); X->CreateNewGuid(); X->PostPlacedNewNode(); X->AllocateDefaultPins(); X->NodePosX = N(A, TEXT("x")); X->NodePosY = N(A, TEXT("y"));
            FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP); return Good(NodeInfo(X));
        }
        if (Action == TEXT("blueprint_connect")) {
            auto From = Node(G, S(A, TEXT("from_node"))), To = Node(G, S(A, TEXT("to_node")));
            auto Out = From ? From->FindPin(FName(*S(A, TEXT("from_pin"))), EGPD_Output) : nullptr;
            auto In = To ? To->FindPin(FName(*S(A, TEXT("to_pin"))), EGPD_Input) : nullptr;
            QC_REQUIRE(Out && In, "Pins not found; inspect actual pin names");
            const auto Response = Schema->CanCreateConnection(Out, In); QC_REQUIRE(Response.Response == CONNECT_RESPONSE_MAKE, "Connection rejected or would replace existing links; inspect pins/types");
            FScopedTransaction Tx(NSLOCTEXT("QCoderI", "Link", "QCoderI: connect Blueprint pins")); BP->Modify(); G->Modify(); From->Modify(); To->Modify();
            QC_REQUIRE(Schema->TryCreateConnection(Out, In), "Connection failed"); FBlueprintEditorUtils::MarkBlueprintAsModified(BP); return Good(NodeInfo(To));
        }
        if (Action == TEXT("blueprint_pin")) {
            auto X = Node(G, S(A, TEXT("node"))); auto Pin = X ? X->FindPin(FName(*S(A, TEXT("pin"))), EGPD_Input) : nullptr;
            QC_REQUIRE(Pin && Pin->LinkedTo.IsEmpty(), "Unlinked input pin required");
            UObject* DefaultObject = nullptr;
            if (A->HasField(TEXT("object_path"))) { DefaultObject = LoadObject<UObject>(nullptr, *S(A, TEXT("object_path"))); QC_REQUIRE(DefaultObject, "Default object not found"); }
            else QC_REQUIRE(A->HasTypedField<EJson::String>(TEXT("value")), "value or object_path required");
            const FString PinError = Schema->IsPinDefaultValid(Pin, S(A, TEXT("value")), DefaultObject, FText::GetEmpty());
            if (!PinError.IsEmpty()) return Fail(PinError);
            FScopedTransaction Tx(NSLOCTEXT("QCoderI", "Pin", "QCoderI: set Blueprint pin")); BP->Modify(); X->Modify();
            if (DefaultObject) Schema->TrySetDefaultObject(*Pin, DefaultObject); else Schema->TrySetDefaultValue(*Pin, S(A, TEXT("value")));
            FBlueprintEditorUtils::MarkBlueprintAsModified(BP); return Good(NodeInfo(X));
        }
    }
    if (Action == TEXT("asset_save")) {
        auto O = Object(A); QC_REQUIRE(O && !O->IsA<AActor>() && !O->IsA<UWorld>(), "Use loaded asset path; level_save for maps");
        if (auto BP = Cast<UBlueprint>(O)) { Compile(BP); QC_REQUIRE(BP->Status != BS_Error, "Blueprint has compiler errors; fix before saving"); }
        QC_REQUIRE(Assets->SaveLoadedAsset(O, false), "Asset save failed"); return Good(Path(O));
    }
    if (Action == TEXT("level_save")) {
        if (A->HasField(TEXT("path"))) {
            const FString P = S(A, TEXT("path"));
            QC_REQUIRE(P.StartsWith(TEXT("/Game/")) && FPackageName::IsValidLongPackageName(P) && !FPackageName::DoesPackageExist(P), "New level path must be a valid unused /Game package");
            const FString Filename = FPackageName::LongPackageNameToFilename(P, FPackageName::GetMapPackageExtension());
            IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
            QC_REQUIRE(FEditorFileUtils::SaveMap(World, Filename), "Save new map failed"); return Good(Path(World));
        }
        QC_REQUIRE(World->GetOutermost()->GetName().StartsWith(TEXT("/Game/")), "Save this level with a /Game name in UE first");
        QC_REQUIRE(FEditorFileUtils::SaveLevel(World->PersistentLevel), "Level save failed"); return Good(Path(World));
    }
    return Fail(TEXT("Unknown command; use describe"));
}
}

class FQCoderIBridgeModule : public IModuleInterface
{
    FTSTicker::FDelegateHandle Handle;
    FString Directory, Instance;
    double LastStatus = 0;
    bool Tick(float)
    {
        const double Now = FDateTime::UtcNow().ToUnixTimestamp();
        if (Now - LastStatus >= 2) {
            auto J = QC::Obj(); J->SetNumberField(TEXT("protocol"), 1); J->SetStringField(TEXT("instance"), Instance); J->SetNumberField(TEXT("updated_at"), Now);
            J->SetBoolField(TEXT("asset_pipeline"), true);
            J->SetBoolField(TEXT("scene_preview"), true);
            J->SetStringField(TEXT("engine"), FEngineVersion::Current().ToString()); J->SetStringField(TEXT("project"), FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()));
            QC::Write(Directory / TEXT("status.json"), J); LastStatus = Now;
        }
        TArray<FString> Files; IFileManager::Get().FindFiles(Files, *(Directory / TEXT("*.request.json")), true, false); Files.Sort();
        for (int Index = 0; Index < FMath::Min(Files.Num(), 4); ++Index) {
            const FString File = Directory / Files[Index]; auto J = QC::Read(File);
            const FString Id = J ? QC::S(J, TEXT("id")) : TEXT(""); FGuid Guid;
            if (!J || !FGuid::ParseExact(Id, EGuidFormats::DigitsWithHyphens, Guid) || Files[Index] != Id + TEXT(".request.json")) { IFileManager::Get().Delete(*File); continue; }
            const FString Claim = Directory / (Id + TEXT(".processing"));
            if (!IFileManager::Get().Move(*Claim, *File, false, true)) continue; // claim once; never replay after a crash
            auto Reply = QC::Fail(TEXT("Expired request or editor restarted; inspect state before retrying"));
            const TSharedPtr<FJsonObject>* Args = nullptr;
            if (QC::N(J, TEXT("protocol")) == 1 && QC::S(J, TEXT("instance")) == Instance && QC::N(J, TEXT("expires_at")) > FDateTime::UtcNow().ToUnixTimestamp() && J->TryGetObjectField(TEXT("args"), Args)) Reply = QC::Dispatch(QC::S(J, TEXT("action")), *Args);
            auto R = QC::Obj(); R->SetStringField(TEXT("id"), Id); R->SetStringField(TEXT("instance"), Instance); R->SetBoolField(TEXT("ok"), Reply.Ok);
            R->SetObjectField(TEXT("result"), Reply.Data); R->SetStringField(TEXT("error"), Reply.Error);
            QC::Write(Directory / (Id + TEXT(".response.json")), R); IFileManager::Get().Delete(*Claim);
        }
        return true;
    }
public:
    virtual void StartupModule() override
    {
        if (IsRunningCommandlet()) return;
        Directory = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir() / TEXT("QCoderI/Bridge")); Instance = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);
        IFileManager::Get().MakeDirectory(*Directory, true);
        Handle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateRaw(this, &FQCoderIBridgeModule::Tick), 0.1f);
    }
    virtual void ShutdownModule() override { if (Handle.IsValid()) FTSTicker::GetCoreTicker().RemoveTicker(Handle); if (!Directory.IsEmpty()) IFileManager::Get().Delete(*(Directory / TEXT("status.json"))); }
};
IMPLEMENT_MODULE(FQCoderIBridgeModule, QCoderIBridge)
