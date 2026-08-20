package service

import (
	"context"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
)

// VolumeService handles volume business logic.
type VolumeService struct {
	volumeRepo repository.VolumeRepository
}

// NewVolumeService creates a new VolumeService.
func NewVolumeService(vr repository.VolumeRepository) *VolumeService {
	return &VolumeService{volumeRepo: vr}
}

// CreateVolume creates a new volume owned by userID and returns the response DTO.
func (s *VolumeService) CreateVolume(ctx context.Context, userID int64, req *dto.CreateVolumeRequest) (*dto.VolumeResponse, error) {
	volume := &model.Volume{
		UserID:  userID,
		NovelID: req.NovelID,
		Title:   req.Title,
	}

	if err := s.volumeRepo.Create(ctx, volume); err != nil {
		return nil, err
	}
	return toVolumeResponse(volume), nil
}

// ListVolumes lists all volumes for a given novel within the user's scope.
func (s *VolumeService) ListVolumes(ctx context.Context, userID, novelID int64) ([]dto.VolumeResponse, error) {
	volumes, err := s.volumeRepo.ListByNovelID(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}

	responses := make([]dto.VolumeResponse, 0, len(volumes))
	for i := range volumes {
		responses = append(responses, *toVolumeResponse(&volumes[i]))
	}
	return responses, nil
}

// UpdateVolume updates an existing volume within the user's scope.
func (s *VolumeService) UpdateVolume(ctx context.Context, userID, id int64, req *dto.UpdateVolumeRequest) (*dto.VolumeResponse, error) {
	volume, err := s.volumeRepo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	if volume == nil {
		return nil, ErrNotFound
	}

	if req.Title != nil {
		volume.Title = *req.Title
	}

	if err := s.volumeRepo.Update(ctx, userID, volume); err != nil {
		return nil, err
	}
	return toVolumeResponse(volume), nil
}

// DeleteVolume deletes a volume by ID within the user's scope.
func (s *VolumeService) DeleteVolume(ctx context.Context, userID, id int64) error {
	volume, err := s.volumeRepo.GetByID(ctx, userID, id)
	if err != nil {
		return err
	}
	if volume == nil {
		return ErrNotFound
	}
	return s.volumeRepo.Delete(ctx, userID, id)
}

func toVolumeResponse(v *model.Volume) *dto.VolumeResponse {
	return &dto.VolumeResponse{
		ID:       v.ID,
		NovelID:  v.NovelID,
		Title:    v.Title,
		Position: v.Position,
	}
}
