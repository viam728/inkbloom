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

// CreateVolume creates a new volume and returns the response DTO.
func (s *VolumeService) CreateVolume(ctx context.Context, req *dto.CreateVolumeRequest) (*dto.VolumeResponse, error) {
	volume := &model.Volume{
		NovelID: req.NovelID,
		Title:   req.Title,
	}

	if err := s.volumeRepo.Create(ctx, volume); err != nil {
		return nil, err
	}
	return toVolumeResponse(volume), nil
}

// ListVolumes lists all volumes for a given novel.
func (s *VolumeService) ListVolumes(ctx context.Context, novelID int64) ([]dto.VolumeResponse, error) {
	volumes, err := s.volumeRepo.ListByNovelID(ctx, novelID)
	if err != nil {
		return nil, err
	}

	responses := make([]dto.VolumeResponse, 0, len(volumes))
	for i := range volumes {
		responses = append(responses, *toVolumeResponse(&volumes[i]))
	}
	return responses, nil
}

// UpdateVolume updates an existing volume.
func (s *VolumeService) UpdateVolume(ctx context.Context, id int64, req *dto.UpdateVolumeRequest) (*dto.VolumeResponse, error) {
	volume, err := s.volumeRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if volume == nil {
		return nil, ErrNotFound
	}

	if req.Title != nil {
		volume.Title = *req.Title
	}

	if err := s.volumeRepo.Update(ctx, volume); err != nil {
		return nil, err
	}
	return toVolumeResponse(volume), nil
}

// DeleteVolume deletes a volume by ID.
func (s *VolumeService) DeleteVolume(ctx context.Context, id int64) error {
	volume, err := s.volumeRepo.GetByID(ctx, id)
	if err != nil {
		return err
	}
	if volume == nil {
		return ErrNotFound
	}
	return s.volumeRepo.Delete(ctx, id)
}

func toVolumeResponse(v *model.Volume) *dto.VolumeResponse {
	return &dto.VolumeResponse{
		ID:       v.ID,
		NovelID:  v.NovelID,
		Title:    v.Title,
		Position: v.Position,
	}
}
