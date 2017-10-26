import { Injectable } from '@angular/core';
import { CanActivate, Router, ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { Observable } from 'rxjs/Observable';

import { StoreService } from 'app/core/store.service';

@Injectable()
export class AuthGuard implements CanActivate {

  constructor(
    private router: Router,
    private storeService: StoreService) {
  }

  canActivate(
    next: ActivatedRouteSnapshot,
    state: RouterStateSnapshot): Observable<boolean> | Promise<boolean> | boolean {
    const userInfo = this.storeService.get('userInfo');
    if (!userInfo || !userInfo.loginName) {
      this.router.navigateByUrl('');
      return false;
    }

    return true;
  }

}
